// Answer policy: decide what to select for every question on a survey page.
//
//  1. The customer's notes and the receipt facts are given to an LLM, which may answer a question
//     ONLY when the notes or receipt give a clear basis (it returns basis "notes" | "receipt" | "none").
//  2. Everything else falls back to deterministic defaults:
//       rating scales            -> the middle option ("Neither satisfied nor dissatisfied", 5 of 0-10, …)
//       personal/demographic     -> "Prefer not to answer" when offered, otherwise left blank
//       contact / sweepstakes    -> "No" when offered, otherwise left blank
//       anything else            -> left blank (the survey lets you skip it; that is "no decision")
//  3. If the site rejects the page because a question is required, the next attempt answers it with
//     the most neutral option available (requiredFallback).
//  Personal details (name, email, phone, address) are never entered.
import { clean } from "./smg.js";
import { categoryOf } from "./brands.js";

export const NA_RE =
  /\b(n\/a|not applicable|does not apply|did not (use|visit|order|receive|have|notice)|didn'?t (use|visit|order|notice)|no opinion|don'?t (know|remember|recall)|do not (know|remember|recall)|not sure|unsure|prefer not|rather not|decline to|no preference|can'?t recall)\b/i;
const PREFER_NOT_RE = /prefer not|rather not|decline to (answer|state)|no preference/i;
const PERSONAL_Q_RE = /\b(your age|age group|gender|your sex|income|ethnic|race|household|children under|zip|postal|education|occupation|marital|birth|how old)\b/i;
const PII_FIELD_RE = /e-?mail|phone|first name|last name|your name|full name|street|address|zip|postal|birth|mobile number/i;
// Yes/no questions where "Yes" is the unremarkable answer (order accurate, received everything, clean…).
const BASELINE_RE = /\b(accurate|correct|right order|as ordered|receive (everything|all)|all of your (order|items)|complete|clean|hot|fresh|open)\b/i;
const PROBLEM_RE = /\b(problem|issue|wrong|incorrect|inaccurate|missing|complain|mistake|error|not\b)/i;
const OPTIN_RE = /sweepstakes|contact you|be contacted|follow[- ]?up|receive (special )?(offers|emails?|texts?|messages)|sign up|subscribe|opt[- ]?in|join (our|the)|newsletter|may we/i;

const SCALE_PATTERNS = [
  [/\bnot (very|too|so) likely\b/, -1],
  [/\bsomewhat likely\b/, 0.5],
  [/\bsomewhat unlikely\b/, -0.5],
  [/\b(highly|very|extremely|completely|totally)\s+satisfied\b/, 2],
  [/\b(highly|very|extremely|completely|totally)\s+dissatisfied\b/, -2],
  [/\bneither\b.*\bsatisfied|\bneutral\b/, 0],
  [/\bdissatisfied\b/, -1],
  [/\bsatisfied\b/, 1],
  [/\b(highly|very|extremely)\s+likely\b|\bdefinitely will\b/, 2],
  [/\b(highly|very|extremely)\s+unlikely\b|\bnot at all likely\b|\bdefinitely (will not|won'?t)\b/, -2],
  [/\bneither\b.*\blikely\b/, 0],
  [/\bunlikely\b|\bprobably (will not|won'?t)\b/, -1],
  [/\blikely\b|\bprobably will\b/, 1],
  [/\bstrongly agree\b/, 2],
  [/\bstrongly disagree\b/, -2],
  [/\bneither agree\b/, 0],
  [/\bdisagree\b/, -1],
  [/\bagree\b/, 1],
  [/\b(excellent|outstanding)\b/, 2],
  [/\bvery good\b/, 1],
  [/\bvery (poor|bad)\b|\bterrible\b/, -2],
  [/\bgood\b|\baverage\b/, 0],
  [/\bfair\b/, -1],
  [/\bpoor\b|\bbad\b/, -2],
  [/\bmuch better\b/, 2],
  [/\bmuch worse\b/, -2],
  [/\babout the same\b|\bthe same\b/, 0],
  [/\bbetter\b/, 1],
  [/\bworse\b/, -1],
  [/\bvery easy\b/, 2],
  [/\bvery (difficult|hard)\b/, -2],
  [/\bneither easy\b/, 0],
  [/\b(difficult|hard)\b/, -1],
  [/\beasy\b/, 1],
];

/** Valence of an option label: -2..2, "na" for not-applicable style options, null if unknown. */
export function scoreLabel(label) {
  const l = clean(label).toLowerCase();
  if (!l) return null;
  if (NA_RE.test(l)) return "na";
  for (const [re, s] of SCALE_PATTERNS) if (re.test(l)) return s;
  return null;
}

const leadingNumber = (label) => {
  const m = clean(label).match(/^(\d{1,2})\b/);
  return m ? Number(m[1]) : null;
};

/** Returns {type:"valence"|"numeric", middle:option} for rating scales, or null. */
export function scaleInfo(unit) {
  if (unit.kind !== "radio" && unit.kind !== "select") return null;
  const opts = unit.options;
  if (opts.length < 3) return null;
  const scored = opts.map((o) => ({ o, s: scoreLabel(o.label) })).filter((x) => typeof x.s === "number");
  if (scored.length >= 3 && scored.some((x) => x.s > 0) && scored.some((x) => x.s < 0)) {
    // SMG codes scales numerically (5 = best … 1 = worst; N/A separate), so the median value is the true
    // middle even when labels are asymmetric ("Highly / Likely / Somewhat / Not very / Not at all likely").
    const cand = opts.filter((o) => scoreLabel(o.label) !== "na");
    const vals = cand.map((o) => Number(o.value));
    if (cand.length >= 3 && vals.every((v) => Number.isFinite(v)) && new Set(vals).size === vals.length) {
      const asc = [...cand].sort((a, b) => Number(a.value) - Number(b.value));
      const sLo = scoreLabel(asc[0].label);
      const sHi = scoreLabel(asc[asc.length - 1].label);
      const positiveUp = !(typeof sLo === "number" && typeof sHi === "number" && sLo > sHi);
      const ordered = positiveUp ? asc : [...asc].reverse(); // worst -> best
      const n = ordered.length;
      const idx = n % 2 ? (n - 1) / 2 : n / 2; // even scales: the milder positive side
      return { type: "valence", middle: ordered[idx], ordered };
    }
    let best = null;
    for (const x of scored) {
      const d = Math.abs(x.s);
      if (!best || d < best.d || (d === best.d && x.s > best.s)) best = { d, s: x.s, o: x.o };
    }
    const ordered = [...scored].sort((a, b) => a.s - b.s).map((x) => x.o);
    return { type: "valence", middle: best.o, ordered };
  }
  const nums = opts.map((o) => ({ o, n: leadingNumber(o.label) })).filter((x) => x.n != null);
  if (nums.length >= 5 && nums.length >= opts.length - 1) {
    nums.sort((a, b) => a.n - b.n);
    return { type: "numeric", middle: nums[Math.floor((nums.length - 1) / 2)].o, ordered: nums.map((x) => x.o) };
  }
  return null;
}

/** Option for a 1-5 rating (1 = very bad, 3 = middle, 5 = great) on any rating scale, by position. */
export function pickByRating(unit, rating) {
  const info = scaleInfo(unit);
  const r = Number(rating);
  if (!info || !(r >= 1 && r <= 5)) return null;
  if (r === 3) return info.middle;
  const o = info.ordered;
  return o[Math.round(((r - 1) / 4) * (o.length - 1))];
}

export const normLabel = (s) =>
  clean(s)
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^a-z0-9$']+/g, " ")
    .trim();

/** A saved ("profile") answer for this question, if the brand defines one and the user set it. */
export function savedAnswer(unit, profileFields, profile) {
  if (!profileFields?.length || !profile || (unit.kind !== "radio" && unit.kind !== "select")) return null;
  const text = unitText(unit);
  const f = profileFields.find((pf) => pf.match.test(text));
  if (!f) return null;
  const want = profile[f.id];
  if (!want) return null;
  const opt = unit.options.find((o) => normLabel(o.label) === normLabel(want));
  if (!opt) return null;
  const extra = {};
  if (f.otherOption && normLabel(want) === normLabel(f.otherOption) && profile[f.id + "Other"]) {
    extra[unit.field + "Other"] = String(profile[f.id + "Other"]).slice(0, 100);
  }
  return { value: opt.value, extra, source: "saved", why: `Saved answer: ${f.label}` };
}

const PROBLEM_Q_RE = /\b(experience|have|had|encounter)\b.*\bproblem|\bany problems?\b/i;
const ACCURATE_Q_RE = /\b(was|were) your (order|items?) (accurate|correct)|order accura/i;

/** Answer from the visit ratings / problem toggle under "Your visit". */
export function ratingAnswer(unit, inputs) {
  const sentiment = inputs?.sentiment || {};
  const text = unitText(unit);
  if (unit.kind !== "radio" && unit.kind !== "select") return null;
  if (isYesNo(unit)) {
    const yes = findOption(unit, /^yes\b/i);
    const no = findOption(unit, /^no\b/i);
    if (PROBLEM_Q_RE.test(text) && (inputs?.problem === "yes" || inputs?.problem === "no")) {
      return { value: (inputs.problem === "yes" ? yes : no).value, source: "your-rating", why: "From “Any problems?”" };
    }
    const acc = Number(sentiment.accuracy);
    if (ACCURATE_Q_RE.test(text) && acc >= 1 && acc <= 5 && acc !== 3) {
      return { value: (acc >= 4 ? yes : no).value, source: "your-rating", why: `Order accuracy rated ${acc}/5` };
    }
    return null;
  }
  if (!scaleInfo(unit)) return null;
  const cat = categoryOf(unit.text) || categoryOf(unit.context);
  const r = Number(sentiment[cat]) || Number(sentiment.overall);
  if (!(r >= 1 && r <= 5)) return null;
  const opt = pickByRating(unit, r);
  if (!opt) return null;
  const used = Number(sentiment[cat]) ? cat : "overall";
  return { value: opt.value, source: "your-rating", why: `${used} rated ${r}/5` };
}

const findOption = (unit, re) => unit.options.find((o) => re.test(clean(o.label)));
const isYesNo = (unit) => unit.options.length === 2 && unit.options.every((o) => /^(yes|no)\b/i.test(clean(o.label)));
const unitText = (u) => clean(`${u.context || ""} ${u.text || ""}`);

/** Deterministic default for a unit. Returns {value(s)/text, source} or null (leave blank). */
export function defaultAnswer(unit) {
  const text = unitText(unit);
  if (unit.kind === "radio" || unit.kind === "select") {
    if (OPTIN_RE.test(text)) {
      const no = findOption(unit, /^no\b/i);
      return no ? { value: no.value, source: "default-decline" } : null;
    }
    const scale = scaleInfo(unit);
    if (scale) return { value: scale.middle.value, source: "default-middle" };
    if (PERSONAL_Q_RE.test(text)) {
      const pn = findOption(unit, PREFER_NOT_RE);
      return pn ? { value: pn.value, source: "default-prefer-not" } : null;
    }
    return null;
  }
  return null;
}

/** Most neutral answer for a question the site insists on. */
export function requiredFallback(unit, facts) {
  const text = unitText(unit);
  if (unit.kind === "radio" || unit.kind === "select") {
    const d = defaultAnswer(unit);
    if (d) return { ...d, source: "required-" + d.source };
    const neutral = findOption(unit, NA_RE) || findOption(unit, /\bneither\b|\bother\b/i);
    if (neutral) return { value: neutral.value, source: "required-neutral" };
    if (isYesNo(unit)) {
      // Forced yes/no with nothing to go on: pick the "nothing unusual happened" answer.
      const yes = findOption(unit, /^yes\b/i);
      const no = findOption(unit, /^no\b/i);
      if (BASELINE_RE.test(text) && !PROBLEM_RE.test(text)) return { value: yes.value, source: "required-no-issue" };
      return { value: no.value, source: "required-no-issue" };
    }
    const mid = unit.options[Math.floor((unit.options.length - 1) / 2)];
    return mid ? { value: mid.value, source: "required-middle-position" } : null;
  }
  if (unit.kind === "checkbox") {
    const neutral = unit.options.find((o) => NA_RE.test(o.label) || /\bnone\b/i.test(o.label));
    return neutral ? { checks: [neutral], source: "required-neutral" } : null;
  }
  if (unit.kind === "text") {
    if (PII_FIELD_RE.test(text) || !unit.multiline) return null;
    return { text: neutralComment(facts), source: "required-neutral-comment" };
  }
  return null;
}

export function neutralComment(facts) {
  const items = facts?.items?.length ? facts.items.map((i) => `${i.qty ? i.qty + " " : ""}${i.name}`).join(" and ") : "my order";
  return `I ordered ${items}. The visit was okay overall; nothing stood out as especially good or bad.`;
}

/** Human-readable summary of the receipt used as "facts" for the LLM. */
export function receiptFacts(receipt) {
  if (!receipt) return "No receipt details.";
  const lines = [];
  if (receipt.brand) lines.push(`Restaurant: ${receipt.brand}`);
  if (receipt.storeNumber || receipt.storeAddress) lines.push(`Store: ${[receipt.storeNumber, receipt.storeAddress].filter(Boolean).join(", ")}`);
  if (receipt.date || receipt.time) lines.push(`Visit date/time printed: ${[receipt.date, receipt.time].filter(Boolean).join(" ")}`);
  if (receipt.orderType) lines.push(`Order type printed on receipt: ${receipt.orderType}`);
  if (receipt.orderChannel) lines.push(`How the order was placed (from receipt): ${receipt.orderChannel}`);
  if (receipt.tableNumber) lines.push(`Table service: table number ${receipt.tableNumber} printed (food brought to the table)`);
  if (receipt.orderNumber) lines.push(`Order number: ${receipt.orderNumber}`);
  if (receipt.items?.length) lines.push(`Items ordered: ${receipt.items.map((i) => `${i.qty || 1} x ${i.name}`).join("; ")}`);
  if (receipt.total) lines.push(`Total: ${receipt.total}`);
  return lines.join("\n");
}

const LLM_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          basis: { type: "string", enum: ["notes", "receipt", "none"] },
          choice: { type: ["string", "null"] },
          choices: { type: "array", items: { type: "string" } },
          text: { type: ["string", "null"] },
          why: { type: "string" },
        },
        required: ["id", "basis"],
      },
    },
  },
  required: ["answers"],
};

const SYSTEM_PROMPT = `You fill out a restaurant customer-satisfaction survey for the customer who visited.
You get: the customer's own notes (may be empty), facts printed on their receipt, and the questions on the current survey page.
Answer a question ONLY when the notes or the receipt facts give a clear basis for it. Otherwise return basis "none" and choice null - the system then applies the default (middle option for ratings, blank for everything else).
Rules:
- Ratings: the default is the middle option. Move up or down only when the notes say something about that aspect (e.g. "fries were cold" -> lower for food temperature/quality; "super fast" -> higher for speed). A general remark ("everything was great", "it was bad") applies to all rating questions.
- Factual questions (how the order was placed, dine-in vs carry-out vs drive-thru, time of day, what was ordered, table service): use the receipt facts, basis "receipt". If the receipt does not settle it, basis "none".
- Yes/no questions about the experience (e.g. "did you have a problem", "were you greeted"): answer only if the notes cover it.
- Comment boxes: if the notes say anything about the visit, write 1-3 short, plain, first-person sentences using ONLY what the notes say (no invented details), basis "notes". If the notes are empty, text null, basis "none".
- Never give names, email addresses, phone numbers or addresses. Never opt in to contact, offers or sweepstakes.
- "choice" must be one of the listed option codes exactly. For checkbox lists use "choices" (array of option codes).
Reply with JSON only: {"answers":[{"id":"Q1","basis":"notes|receipt|none","choice":"<code or null>","choices":[],"text":null,"why":"short reason"}]}`;

function describeUnits(units) {
  return units
    .map((u, i) => {
      const id = `Q${i + 1}`;
      const head = `${id} [${u.kind}${u.multiline ? " comment box" : ""}] ${u.context ? u.context + " > " : ""}${u.text || "(no question text)"}`;
      if (u.kind === "text") return head;
      const opts = u.options.map((o, j) => `   ${u.kind === "checkbox" ? String(j) : o.value} = ${o.label}`).join("\n");
      return `${head}\n${opts}`;
    })
    .join("\n");
}

function parseJsonLoose(out) {
  if (out == null) return null;
  if (typeof out === "object" && out.answers) return out;
  let s = typeof out === "string" ? out : JSON.stringify(out);
  s = s.replace(/^```(?:json)?/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

export function aiText(resp) {
  if (resp == null) return null;
  if (typeof resp === "string") return resp;
  if (resp.response != null) return resp.response;
  const c = resp.choices?.[0]?.message?.content;
  if (c != null) return c;
  if (resp.result) return aiText(resp.result);
  return resp;
}

/** Ask the LLM about this page. Returns Map id -> answer (or empty Map on failure). */
export async function askModel(env, { units, notes, facts, pageText }) {
  const model = env.TEXT_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const user = `CUSTOMER NOTES:\n${notes?.trim() ? notes.trim() : "(none)"}\n\nRECEIPT FACTS:\n${facts}\n\nSURVEY PAGE QUESTIONS:\n${describeUnits(units)}`;
  const resp = await env.AI.run(model, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: LLM_SCHEMA },
    max_tokens: 1500,
    temperature: 0.1,
  });
  const parsed = parseJsonLoose(aiText(resp));
  const map = new Map();
  for (const a of parsed?.answers || []) if (a?.id) map.set(String(a.id).trim().toUpperCase(), a);
  return { map, model, raw: typeof aiText(resp) === "string" ? aiText(resp).slice(0, 4000) : JSON.stringify(aiText(resp)).slice(0, 4000) };
}

const needsModel = (units, notes) =>
  !!notes?.trim() || units.some((u) => (u.kind === "radio" || u.kind === "select" || u.kind === "checkbox") && !scaleInfo(u));

/**
 * Decide answers for a page.
 * Returns { answers: {field: value}, decisions: [{question, answer, source, why}], model }
 *   forceRequired: Set of unit indexes (or true for all unanswered) the site said must be answered.
 */
export async function decidePage(env, page, { notes, receipt, inputs = null, profileFields = null, forceRequired = null, overrides = null }) {
  const units = page.units;
  const facts = receiptFacts(receipt);
  let llm = { map: new Map(), model: null, raw: null, error: null };
  if (units.length && needsModel(units, notes) && env.AI) {
    try {
      llm = { ...(await askModel(env, { units, notes, facts, pageText: page.pageText })), error: null };
    } catch (e) {
      llm.error = String(e?.message || e).slice(0, 300);
    }
  }

  const answers = {};
  const decisions = [];
  const hasNotes = !!notes?.trim();
  units.forEach((u, i) => {
    const id = `Q${i + 1}`;
    const text = unitText(u);
    const a = llm.map.get(id);
    let picked = null;

    // Precedence: review override > saved answer > notes/receipt (model) > your visit ratings > defaults > required fallback.
    const override = overrides?.[u.field || u.key];
    if (override !== undefined) {
      picked = override === null ? { skip: true, source: "review-override" } : { value: override, text: override, source: "review-override" };
    }
    if (!picked) picked = savedAnswer(u, profileFields, inputs?.profile);

    const llmAllowed =
      a && a.basis && a.basis !== "none" && !(a.basis === "notes" && !hasNotes) && !(scaleInfo(u) && a.basis !== "notes"); // ratings move only on notes
    if (!picked && llmAllowed) {
      if ((u.kind === "radio" || u.kind === "select") && a.choice != null) {
        const opt = u.options.find((o) => o.value === String(a.choice).trim());
        if (opt && !(OPTIN_RE.test(text) && !/^no\b/i.test(opt.label))) picked = { value: opt.value, source: a.basis, why: a.why };
      } else if (u.kind === "checkbox" && Array.isArray(a.choices) && a.choices.length) {
        const checks = a.choices.map((c) => u.options[Number(c)]).filter(Boolean);
        if (checks.length && !OPTIN_RE.test(text)) picked = { checks, source: a.basis, why: a.why };
      } else if (u.kind === "text" && u.multiline && a.text && hasNotes && !PII_FIELD_RE.test(text)) {
        picked = { text: String(a.text).trim(), source: a.basis, why: a.why };
      }
    }
    if (!picked) picked = ratingAnswer(u, inputs);
    if (!picked) picked = defaultAnswer(u);
    const mustAnswer = forceRequired === true || (forceRequired instanceof Set && forceRequired.has(i)) || u.error;
    if (!picked && mustAnswer) picked = requiredFallback(u, receipt);

    let shown = "(left blank)";
    let source = null;
    if (picked && !picked.skip) {
      if (u.kind === "radio" || u.kind === "select") {
        if (picked.value != null && u.options.some((o) => o.value === String(picked.value))) {
          answers[u.field] = String(picked.value);
          shown = u.options.find((o) => o.value === String(picked.value)).label;
          for (const [k, v] of Object.entries(picked.extra || {})) answers[k] = v;
        }
      } else if (u.kind === "checkbox") {
        for (const c of picked.checks || []) answers[c.field] = c.value;
        shown = (picked.checks || []).map((c) => c.label).join(", ") || shown;
      } else if (u.kind === "text" && (picked.text || picked.value)) {
        let t = String(picked.text || picked.value);
        if (u.maxLength) t = t.slice(0, u.maxLength);
        answers[u.field] = t;
        shown = t;
      }
      if (shown !== "(left blank)") source = picked.source;
    }
    if (!source && u.kind === "text" && answers[u.field]) {
      shown = answers[u.field]; // filled alongside a saved "Somewhere else" choice
      source = "saved";
    }
    decisions.push({
      id,
      field: u.field || u.key,
      kind: u.kind,
      question: text || "(no text)",
      answer: shown,
      source: source || "skipped",
      why: source ? picked?.why || null : null,
      options: u.kind === "text" ? undefined : u.options.map((o) => o.label),
    });
  });
  return { answers, decisions, model: llm.model, llmError: llm.error };
}
