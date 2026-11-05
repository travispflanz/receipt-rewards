// Receipt reading with a Workers AI vision model.
// Input format verified against the model schema (2026-11-05): messages[].content may be an array of
// {type:"text"} and {type:"image_url", image_url:{url:"data:image/jpeg;base64,..."}} parts.
import { aiText } from "./answer.js";
import { formatSurveyCode } from "./smg.js";
import { detectBrand } from "./brands.js";

const PROMPT = `Read this photo of a restaurant receipt. The photo may be rotated sideways or upside down - read it in whatever orientation the text runs.
Return ONLY a JSON object with these keys (use null when something is not printed):
{
 "brand": "restaurant name, e.g. McDonald's",
 "surveyCode": "the long survey code exactly as printed, digits and dashes (McDonald's prints 26 digits like 12345-12345-12345-12345-12345-1, usually next to the words 'Survey Code')",
 "surveyUrl": "survey website printed, e.g. www.mcdvoice.com",
 "offerText": "the survey offer, e.g. Buy One Get One ...",
 "storeNumber": null,
 "storeAddress": null,
 "date": "MM/DD/YYYY",
 "time": "h:mm AM/PM",
 "orderNumber": null,
 "orderType": "as printed, e.g. Eat In, Take Out, Drive Thru",
 "orderChannel": "how it was ordered if printed: Mobile (app), Kiosk, Counter, Drive Thru, Delivery",
 "tableNumber": null,
 "customerName": null,
 "items": [{"qty": 1, "name": "item as printed"}],
 "total": null,
 "rawText": "all text on the receipt, line by line"
}`;

export async function readReceipt(env, dataUrl) {
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(dataUrl || "")) throw new Error("Expected a base64 image data URL");
  const model = env.VISION_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct";
  const resp = await env.AI.run(model, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 1200,
    temperature: 0,
  });
  const out = aiText(resp);
  let data = null;
  if (out && typeof out === "object") data = out;
  else {
    const s = String(out || "");
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        data = JSON.parse(s.slice(a, b + 1));
      } catch {
        data = null;
      }
    }
  }
  if (!data) return { ok: false, model, error: "Could not read the receipt", raw: String(out).slice(0, 2000) };
  return { ok: true, model, receipt: normalizeReceipt(data) };
}

export function normalizeReceipt(r) {
  const out = { ...r };
  // Survey code: keep digits; fall back to searching the raw text for 26 digits in 5-5-5-5-5-1 groups.
  let code = formatSurveyCode(r.surveyCode);
  if (!code && r.rawText) {
    const m = String(r.rawText).match(/(\d{5})\s*-\s*(\d{5})\s*-\s*(\d{5})\s*-\s*(\d{5})\s*-\s*(\d{5})\s*-\s*(\d)/);
    if (m) code = m.slice(1).join("-");
  }
  out.surveyCode = code;
  out.surveyCodeRaw = r.surveyCode || null;
  const raw = `${r.rawText || ""}\n${r.surveyUrl || ""}\n${r.brand || ""}`;
  out.brandId = detectBrand(raw)?.id || null;
  // McDonald's prints "Mobile" at the start of the footer line for app orders.
  if (!out.orderChannel && /(^|\n)\s*mobile\b/i.test(r.rawText || "")) out.orderChannel = "Mobile (app)";
  if (!Array.isArray(out.items)) out.items = [];
  out.items = out.items
    .filter((i) => i && i.name)
    .map((i) => ({ qty: Number(i.qty) || 1, name: String(i.name).trim() }));
  return out;
}
