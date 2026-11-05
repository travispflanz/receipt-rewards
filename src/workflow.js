// Durable background run of one survey. One survey page = one "plan" step + one "submit" step, so each
// step stays far below the Workers Free 10 ms CPU limit and the run survives the phone being closed.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { browse } from "./http.js";
import { parseSmgPage, buildSubmission, splitSurveyCode } from "./smg.js";
import { decidePage } from "./answer.js";
import { brandById } from "./brands.js";
import { getRun, updateRun, appendLog, savePage } from "./db.js";

const NET = { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "2 minutes" };
const AI = { retries: { limit: 2, delay: "3 seconds", backoff: "linear" }, timeout: "3 minutes" };
const DB = { retries: { limit: 3, delay: "2 seconds", backoff: "linear" }, timeout: "1 minute" };
const MAX_PAGES = 45;

const postedFns = (page) => page.hidden.find((h) => h.name === "PostedFNS")?.value || null;

export class SurveyRun extends WorkflowEntrypoint {
  async run(event, step) {
    const { runId } = event.payload;
    const db = this.env.DB;
    try {
      const ctx = await step.do("load run", DB, async () => {
        const r = await getRun(db, runId);
        if (!r) throw new NonRetryableError(`Run ${runId} not found`);
        return { brand: r.brand, surveyCode: r.survey_code, notes: r.notes || "", receipt: r.receipt || {}, review: !!r.review };
      });
      const brand = brandById(ctx.brand);
      if (!brand) throw new NonRetryableError(`Unsupported restaurant: ${ctx.brand}`);

      let state = await step.do("open survey and enter code", NET, async () => {
        await updateRun(db, runId, { status: "running", stage: "Opening the survey site" });
        const jar = {};
        const landing = await browse(brand.surveyUrl, { jar });
        await savePage(db, runId, 0, landing);
        const entry = parseSmgPage(landing.html, landing.url);
        if (entry.kind !== "entry") throw new Error(`Survey start page not recognised (HTTP ${landing.status}: ${entry.title || entry.pageText.slice(0, 120)})`);
        const body = buildSubmission(entry, splitSurveyCode(ctx.surveyCode));
        const res = await browse(entry.action, { method: "POST", body, jar, referer: landing.url });
        await savePage(db, runId, 1, res);
        await updateRun(db, runId, { stage: "Survey code accepted? Checking first page" });
        return { url: res.url, html: res.html, status: res.status, jar, seq: 1, prevSig: null };
      });

      let repeats = 0;
      for (let i = 1; i <= MAX_PAGES; i++) {
        const plan = await step.do(`plan page ${i}`, AI, async () => {
          const page = parseSmgPage(state.html, state.url);
          if (page.kind === "finish") return { done: true, validationCode: page.validationCode, validationText: page.validationText };
          if (page.kind === "entry") {
            const why = page.errors.join(" ") || page.pageText.slice(0, 300);
            throw new NonRetryableError(`The survey site did not accept the code: ${why}`);
          }
          if (page.kind !== "question") {
            throw new NonRetryableError(`Unexpected page from the survey site: ${page.title} — ${page.pageText.slice(0, 400)}`);
          }
          const sig = postedFns(page);
          const repeated = !!sig && sig === state.prevSig;
          const decided = await decidePage(this.env, page, { notes: ctx.notes, receipt: ctx.receipt, forceRequired: repeated ? true : null });
          await appendLog(
            db,
            runId,
            { type: "page", n: i, repeated, errors: repeated ? page.errors : [], model: decided.model, llmError: decided.llmError, decisions: decided.decisions },
            { stage: repeated ? `Page ${i}: site asked for more answers` : `Answering page ${i}` },
          );
          return { done: false, sig, repeated, answers: decided.answers, decisions: decided.decisions };
        });

        if (plan.done) {
          const out = await step.do("save validation code", DB, async () => {
            await updateRun(db, runId, {
              status: "done",
              stage: "Done",
              validation_code: plan.validationCode,
              validation_text: plan.validationText,
              pending_json: null,
            });
            await appendLog(db, runId, { type: "done", validationCode: plan.validationCode });
            return { validationCode: plan.validationCode, validationText: plan.validationText };
          });
          return out;
        }

        repeats = plan.repeated ? repeats + 1 : 0;
        if (repeats > 2) throw new NonRetryableError(`Page ${i} keeps coming back from the survey site; stopping so nothing is guessed.`);

        let answers = plan.answers;
        if (ctx.review) {
          await step.do(`hold page ${i} for review`, DB, async () => {
            await updateRun(db, runId, {
              status: "review",
              stage: `Waiting for your OK on page ${i}`,
              pending_json: JSON.stringify({ page: i, decisions: plan.decisions }),
            });
          });
          const ev = await step.waitForEvent(`review page ${i}`, { type: `review-${i}`, timeout: "15 minutes" });
          const p = ev?.payload ?? ev ?? {};
          if (p.action === "abort") throw new NonRetryableError("Stopped from the review screen");
          if (p.overrides && typeof p.overrides === "object") {
            answers = { ...answers };
            for (const [field, value] of Object.entries(p.overrides)) {
              if (value === null || value === "") delete answers[field];
              else answers[field] = String(value);
            }
          }
        }

        state = await step.do(`submit page ${i}`, NET, async () => {
          const page = parseSmgPage(state.html, state.url);
          const body = buildSubmission(page, answers);
          const res = await browse(page.action, { method: "POST", body, jar: state.jar, referer: state.url });
          await savePage(db, runId, state.seq + 1, res);
          await updateRun(db, runId, { status: "running", pages_done: i, pending_json: null, stage: `Submitted page ${i}` });
          return { url: res.url, html: res.html, status: res.status, jar: state.jar, seq: state.seq + 1, prevSig: plan.sig };
        });
      }
      throw new NonRetryableError(`No validation code after ${MAX_PAGES} pages`);
    } catch (err) {
      const message = String(err?.message || err).slice(0, 800);
      await step.do("record failure", DB, async () => {
        await updateRun(db, runId, { status: "error", stage: "Stopped", error: message, pending_json: null });
      });
      throw err;
    }
  }
}
