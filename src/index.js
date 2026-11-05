// Receipt Rewards — snap a receipt, add notes, get the survey reward code.
import { readReceipt, normalizeReceipt } from "./ocr.js";
import { BRANDS, brandById, detectBrand } from "./brands.js";
import { formatSurveyCode } from "./smg.js";
import { createRun, getRun, listRuns, listPages, getPage, updateRun } from "./db.js";
import UI_HTML from "./ui.html";

export { SurveyRun } from "./workflow.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function authorized(req, env) {
  if (!env.APP_PASSCODE) return true;
  const given = req.headers.get("x-passcode") || new URL(req.url).searchParams.get("passcode") || "";
  return safeEqual(given, env.APP_PASSCODE);
}

async function handleApi(req, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  if (path === "/api/health") return json({ ok: true });
  if (!authorized(req, env)) return json({ error: "passcode required" }, 401);

  if (path === "/api/session" && method === "GET") return json({ ok: true, brands: BRANDS.map(({ id, name, codeFormat, reward, limits }) => ({ id, name, codeFormat, reward, limits })) });

  if (path === "/api/extract" && method === "POST") {
    const { image } = await req.json();
    const r = await readReceipt(env, image);
    return json(r, r.ok ? 200 : 422);
  }

  if (path === "/api/runs" && method === "POST") {
    const body = await req.json();
    const receipt = normalizeReceipt({ ...(body.receipt || {}), surveyCode: body.surveyCode || body.receipt?.surveyCode });
    const surveyCode = formatSurveyCode(body.surveyCode || receipt.surveyCode);
    if (!surveyCode) return json({ error: "A 26-digit survey code is required (type it in if the photo could not be read)." }, 400);
    const brand = brandById(body.brandId) || brandById(receipt.brandId) || detectBrand(JSON.stringify(receipt)) || (BRANDS.length === 1 ? BRANDS[0] : null);
    if (!brand) return json({ error: "Could not tell which restaurant this receipt is from." }, 400);
    const id = `run-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    await createRun(env.DB, { id, brand: brand.id, surveyCode, notes: String(body.notes || "").slice(0, 4000), receipt, review: !!body.review });
    await env.SURVEY_RUN.create({ id, params: { runId: id } });
    return json({ id });
  }

  if (path === "/api/runs" && method === "GET") return json({ runs: await listRuns(env.DB, 30) });

  const m = path.match(/^\/api\/runs\/([\w-]+)(?:\/(review|cancel|pages)(?:\/(\d+))?)?$/);
  if (m) {
    const [, id, action, seq] = m;
    const run = await getRun(env.DB, id);
    if (!run) return json({ error: "not found" }, 404);
    if (!action && method === "GET") {
      let workflow = null;
      try {
        workflow = await (await env.SURVEY_RUN.get(id)).status();
      } catch (e) {
        workflow = { status: "unknown", error: String(e?.message || e) };
      }
      // If the workflow died without recording why, surface it.
      if (["errored", "terminated"].includes(workflow?.status) && run.status !== "error" && run.status !== "done") {
        await updateRun(env.DB, id, { status: "error", error: workflow.error?.message || workflow.status, stage: "Stopped" });
        run.status = "error";
        run.error = workflow.error?.message || workflow.status;
      }
      return json({ run, workflow: { status: workflow?.status, error: workflow?.error || null } });
    }
    if (action === "review" && method === "POST") {
      const b = await req.json();
      const page = Number(b.page || run.pending?.page);
      if (!page) return json({ error: "nothing is waiting for review" }, 409);
      await (await env.SURVEY_RUN.get(id)).sendEvent({ type: `review-${page}`, payload: { action: b.action === "abort" ? "abort" : "approve", overrides: b.overrides || null } });
      await updateRun(env.DB, id, { status: "running", stage: b.action === "abort" ? "Stopping" : `Page ${page} approved`, pending_json: null });
      return json({ ok: true });
    }
    if (action === "cancel" && method === "POST") {
      try {
        await (await env.SURVEY_RUN.get(id)).terminate();
      } catch {}
      await updateRun(env.DB, id, { status: "error", stage: "Stopped", error: "Cancelled" });
      return json({ ok: true });
    }
    if (action === "pages" && method === "GET") {
      if (seq != null) {
        const p = await getPage(env.DB, id, Number(seq));
        if (!p) return json({ error: "not found" }, 404);
        return new Response(p.html, { headers: { "content-type": "text/plain; charset=utf-8", "x-page-url": p.url || "" } });
      }
      return json({ pages: await listPages(env.DB, id) });
    }
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url);
      } catch (e) {
        return json({ error: String(e?.message || e) }, 500);
      }
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(UI_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
