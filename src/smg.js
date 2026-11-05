// Parser for SMG (Service Management Group) survey pages — the platform behind mcdvoice.com and
// many other "tell us about your visit" receipt surveys.
//
// Markup verified against live mcdvoice.com pages (2026-11-05):
//   entry page:   form#surveyEntryForm, inputs CN1..CN6, hidden JavaScriptEnabled/FIP/AllowCapture,
//                 <input type=submit name=NextButton value=Start>
//   survey pages: form#surveyForm action="Survey.aspx?c=NNN", one .FNSITEM per question (id FNS<field>),
//                 question text in #text<field>, radio inputs name=<field> with labels #text<field>.<value>,
//                 hidden IoNF + PostedFNS, NextButton without a name.
//   finish page:  .ValCode "Validation Code: XXXXX" (confirmed by several open-source survey tools).
import { parse } from "node-html-parser";

const PARSE_OPTS = { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } };
const SKIP_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "file"]);

export const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Parse one survey page into a plain, serializable description. */
export function parseSmgPage(html, pageUrl) {
  const root = parse(html, PARSE_OPTS);
  const byId = new Map();
  for (const el of root.querySelectorAll("[id]")) if (!byId.has(el.id)) byId.set(el.id, el);
  const labelFor = new Map();
  for (const l of root.querySelectorAll("label[for]")) labelFor.set(l.getAttribute("for"), clean(l.text));

  const title = clean(root.querySelector("title")?.text);
  const bodyClass = root.querySelector("body")?.getAttribute("class") || "";
  const contentEl = root.querySelector("#surveyQuestions") || root.querySelector("#content") || root.querySelector("body") || root;
  const pageText = clean(contentEl.text).slice(0, 3000);

  // Validation code (final page).
  let validationCode = null;
  const valEl = root.querySelector(".ValCode");
  const valText = clean(valEl?.text) || "";
  // Only a code that contains digits counts ("…you will be given a validation code that…" must not match).
  const codeRe = /validation\s*code\s*(?:is\s*)?[:#]\s*([A-Z0-9-]*\d[A-Z0-9-]*)/i;
  const m = valText.match(codeRe) || (valText && valText.match(/\b([A-Z0-9-]*\d[A-Z0-9-]{2,})\b/i)) || pageText.match(codeRe);
  if (m && /\d/.test(m[1]) && m[1].replace(/-/g, "").length >= 4) validationCode = m[1];

  const form = root.querySelector("form#surveyForm") || root.querySelector("form#surveyEntryForm") || root.querySelector("form");
  const page = {
    url: pageUrl || null,
    title,
    bodyClass,
    pageText,
    validationCode,
    validationText: valText || null,
    kind: "unknown",
    action: null,
    hidden: [],
    submit: null,
    units: [],
    errors: [],
  };
  if (validationCode) page.kind = "finish";
  if (!form) return page;

  page.action = absolute(form.getAttribute("action") || "", pageUrl);
  for (const h of form.querySelectorAll("input")) {
    const type = (h.getAttribute("type") || "text").toLowerCase();
    const name = h.getAttribute("name");
    if (type === "hidden" && name) page.hidden.push({ name, value: h.getAttribute("value") ?? "" });
    if (type === "submit" && !page.submit) page.submit = { name: name || null, value: h.getAttribute("value") ?? "" };
  }

  if (form.querySelector("#CN1")) {
    page.kind = validationCode ? "finish" : "entry";
  } else if (!validationCode) {
    page.kind = "question";
  }

  // Page-level error messages.
  for (const el of root.querySelectorAll("[class*=rror], [id*=rror]")) {
    if (el.tagName === "INPUT") continue;
    const t = clean(el.text);
    if (t && t.length < 400 && !page.errors.includes(t)) page.errors.push(t);
  }

  page.units = extractUnits(form, byId, labelFor);
  if (page.kind === "question" && page.units.length === 0 && !page.hidden.some((h) => h.name === "PostedFNS")) {
    page.kind = "unknown";
  }
  return page;
}

function absolute(href, base) {
  if (!href) return base || null;
  try {
    return new URL(href, base || "https://www.mcdvoice.com/").toString();
  } catch {
    return href;
  }
}

function attrText(el) {
  return clean(el?.getAttribute("aria-label") || el?.getAttribute("title") || "");
}

/** Closest ancestor that is an SMG question container (.FNSITEM or id starting "FNS"). */
function containerOf(el) {
  let p = el.parentNode;
  while (p && p.tagName) {
    const id = p.id || "";
    const cls = p.getAttribute?.("class") || "";
    if (/^FNS/.test(id) || /\bFNSITEM\b/.test(cls)) return p;
    p = p.parentNode;
  }
  return null;
}

function questionTextFor(name, container, byId) {
  const direct = byId.get("text" + name);
  if (direct) return clean(direct.text);
  if (container) {
    const lead = container.querySelector("legend, .FNSText, label");
    if (lead) return clean(lead.text);
    const labelled = container.getAttribute("aria-labelledby");
    if (labelled && byId.get(labelled)) return clean(byId.get(labelled).text);
  }
  return "";
}

/** For an input inside a table grid, return the header text of its column. */
function gridHeaderLabel(input) {
  let cell = input.parentNode;
  while (cell && cell.tagName && cell.tagName !== "TD" && cell.tagName !== "TH") cell = cell.parentNode;
  if (!cell || !cell.tagName) return "";
  const row = cell.parentNode;
  let table = row?.parentNode;
  while (table && table.tagName && table.tagName !== "TABLE") table = table.parentNode;
  if (!row || !table || !table.tagName) return "";
  const idx = row.childNodes.filter((n) => n.tagName === "TD" || n.tagName === "TH").indexOf(cell);
  if (idx < 0) return "";
  for (const r of table.querySelectorAll("tr")) {
    if (r === row) break;
    const cells = r.childNodes.filter((n) => n.tagName === "TD" || n.tagName === "TH");
    const t = clean(cells[idx]?.text);
    if (t) return t;
  }
  return "";
}

function optionLabel(input, byId, labelFor) {
  const id = input.id;
  if (id && byId.get("text" + id)) return clean(byId.get("text" + id).text);
  if (id && labelFor.get(id)) return labelFor.get(id);
  // Grid columns: <input aria-labelledby="HighlyLikelyDESC5"> -> <th id="HighlyLikelyDESC5">Highly Likely</th>
  const lb = (input.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  const lbText = clean(lb.map((x) => byId.get(x)?.text || "").join(" "));
  if (lbText) return lbText;
  const wrapping = input.closest?.("label");
  if (wrapping && clean(wrapping.text)) return clean(wrapping.text);
  const a = attrText(input);
  if (a) return a;
  const g = gridHeaderLabel(input);
  if (g) return g;
  return clean(input.getAttribute("value"));
}

/**
 * Turn the form's controls into decision units:
 *   radio    {kind, field, text, context, options:[{value,label}]}
 *   select   {kind, field, text, context, options:[{value,label}]}
 *   checkbox {kind, key, text, options:[{field,value,label}]}   (one unit per question container)
 *   text     {kind, field, text, multiline, maxLength}
 */
function extractUnits(form, byId, labelFor) {
  const units = [];
  const radioUnits = new Map();
  const checkboxUnits = new Map();
  for (const el of form.querySelectorAll("input, select, textarea")) {
    const tag = el.tagName;
    const type = tag === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : tag.toLowerCase();
    const name = el.getAttribute("name");
    if (!name || SKIP_TYPES.has(type)) continue;
    if (/^CN\d$/.test(name)) continue; // entry code boxes are handled separately
    const container = containerOf(el);
    const containerText = container ? questionTextFor(container.id.replace(/^FNS/, ""), container, byId) : "";
    const flagged = !!container && /error/i.test(container.getAttribute("class") || "");
    const disabled = el.getAttribute("disabled") != null;
    if (disabled) continue;

    if (type === "radio") {
      let u = radioUnits.get(name);
      if (!u) {
        const text = questionTextFor(name, container, byId) || containerText;
        u = { kind: "radio", field: name, text, context: containerText && containerText !== text ? containerText : "", options: [], error: flagged };
        radioUnits.set(name, u);
        units.push(u);
      }
      u.options.push({ value: el.getAttribute("value") ?? "", label: optionLabel(el, byId, labelFor) });
    } else if (type === "checkbox") {
      // "Select all that apply" lists: each box sits in its own FNS block, the question is the fieldset legend.
      const group = el.closest?.("fieldset") || container;
      const legend = group?.tagName === "FIELDSET" ? clean(group.querySelector("legend")?.text) : "";
      const key = (group?.tagName === "FIELDSET" && (group.querySelector("legend")?.id || group.id)) || container?.id || "CB-" + name;
      let u = checkboxUnits.get(key);
      if (!u) {
        const gFlag = !!group && /error/i.test(group.getAttribute("class") || "");
        u = { kind: "checkbox", key, text: legend || containerText || questionTextFor(name, container, byId), options: [], error: flagged || gFlag };
        checkboxUnits.set(key, u);
        units.push(u);
      }
      u.options.push({ field: name, value: el.getAttribute("value") ?? "on", label: optionLabel(el, byId, labelFor) });
    } else if (tag === "SELECT") {
      const options = el
        .querySelectorAll("option")
        .map((o) => ({ value: o.getAttribute("value") ?? clean(o.text), label: clean(o.text) }))
        .filter((o) => o.value !== "" && !/^(-+|select|choose|please select)/i.test(o.label));
      units.push({ kind: "select", field: name, text: questionTextFor(name, container, byId) || containerText, context: "", options, error: flagged });
    } else {
      // text, textarea, number, email, tel …
      units.push({
        kind: "text",
        field: name,
        inputType: type,
        text: questionTextFor(name, container, byId) || containerText || attrText(el) || labelFor.get(el.id) || "",
        multiline: tag === "TEXTAREA",
        maxLength: Number(el.getAttribute("maxlength")) || null,
        error: flagged,
      });
    }
  }
  return units;
}

/**
 * Build the urlencoded body a browser would send for this page.
 * answers: Map/object field -> string value (radio/select/text) and, for checkboxes, field -> value.
 */
export function buildSubmission(page, answers, extra = {}) {
  const body = new URLSearchParams();
  for (const h of page.hidden) {
    let v = h.value;
    if (h.name === "JavaScriptEnabled") v = "1"; // the site's own script flips this on load
    if (h.name in extra) v = extra[h.name];
    body.append(h.name, v);
  }
  for (const [k, v] of Object.entries(extra)) if (!page.hidden.some((h) => h.name === k)) body.append(k, v);
  for (const [field, value] of Object.entries(answers || {})) {
    if (value == null || value === "") continue;
    body.append(field, String(value));
  }
  if (page.submit?.name) body.append(page.submit.name, page.submit.value);
  return body;
}

/** Split a 26-digit SMG survey code into the CN1..CN6 boxes (5-5-5-5-5-1). */
export function splitSurveyCode(code) {
  const d = String(code || "").replace(/\D/g, "");
  if (d.length !== 26) throw new Error(`Survey code must have 26 digits (got ${d.length})`);
  return { CN1: d.slice(0, 5), CN2: d.slice(5, 10), CN3: d.slice(10, 15), CN4: d.slice(15, 20), CN5: d.slice(20, 25), CN6: d.slice(25) };
}

export const formatSurveyCode = (code) => {
  const d = String(code || "").replace(/\D/g, "");
  return d.length === 26 ? `${d.slice(0, 5)}-${d.slice(5, 10)}-${d.slice(10, 15)}-${d.slice(15, 20)}-${d.slice(20, 25)}-${d.slice(25)}` : null;
};
