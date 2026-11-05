import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseSmgPage, buildSubmission, splitSurveyCode, formatSurveyCode } from "../src/smg.js";
import { scaleInfo, defaultAnswer, requiredFallback, scoreLabel, decidePage, receiptFacts } from "../src/answer.js";
import { normalizeReceipt } from "../src/ocr.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

const SAMPLE_RECEIPT = normalizeReceipt({
  brand: "McDonald's",
  surveyCode: "26263-16221-10526-14030-00017-2",
  surveyUrl: "www.mcdvoice.com",
  date: "11/05/2026",
  time: "02:04 PM",
  orderNumber: "1622",
  orderType: "Eat In",
  tableNumber: "107",
  customerName: "Travis",
  items: [
    { qty: 1, name: "M Fry" },
    { qty: 1, name: "L Dr Pepper" },
  ],
  rawText: "Eat In Order 1622\n1 M Fry\n1 L Dr Pepper\nTABLE 107\nName: Travis\nMobile 11/05/2026 02:04 PM",
});

describe("live mcdvoice markup (captured 2026-11-05)", () => {
  it("recognises the entry page and builds the code submission", () => {
    const p = parseSmgPage(fx("mcd-entry.html"), "https://www.mcdvoice.com/?AspxAutoDetectCookieSupport=1");
    expect(p.kind).toBe("entry");
    expect(p.action).toMatch(/^https:\/\/www\.mcdvoice\.com\/Survey\.aspx\?c=\d+$/);
    const body = buildSubmission(p, splitSurveyCode("26263-16221-10526-14030-00017-2"));
    expect(body.get("JavaScriptEnabled")).toBe("1");
    expect(body.get("FIP")).toBe("True");
    expect(body.get("CN1")).toBe("26263");
    expect(body.get("CN6")).toBe("2");
    expect(body.get("NextButton")).toBe("Start");
  });

  it("parses the first question page (order method)", () => {
    const p = parseSmgPage(fx("mcd-page1-order-method.html"), "https://www.mcdvoice.com/Survey.aspx?c=201714");
    expect(p.kind).toBe("question");
    expect(p.action).toMatch(/Survey\.aspx\?c=\d+$/);
    expect(p.units).toHaveLength(1);
    const u = p.units[0];
    expect(u.field).toBe("R000455");
    expect(u.text).toBe("How did you place your order?");
    expect(u.options.map((o) => o.label)).toEqual([
      "Using a kiosk inside the restaurant",
      "Using the McDonald’s Mobile app",
      "With an employee at the restaurant",
    ]);
    const body = buildSubmission(p, { R000455: "3" });
    expect(body.get("PostedFNS")).toBe("S000100|R000455");
    expect(body.get("IoNF")).toBe("4");
    expect(body.get("R000455")).toBe("3");
    expect(body.has("NextButton")).toBe(false); // the live Next button has no name
  });
});

const GRID = `<html><body><form method="post" id="surveyForm" action="Survey.aspx?c=5">
<div id="surveyQuestions">
<table class="FNSITEM" id="FNSG1"><thead><tr><th></th><th>Highly Satisfied</th><th>Satisfied</th><th>Neither Satisfied nor Dissatisfied</th><th>Dissatisfied</th><th>Highly Dissatisfied</th></tr></thead>
<tbody>
<tr id="FNSR001000" role="radiogroup"><td id="textR001000">The speed of service</td><td><input type="radio" name="R001000" value="5"></td><td><input type="radio" name="R001000" value="4"></td><td><input type="radio" name="R001000" value="3"></td><td><input type="radio" name="R001000" value="2"></td><td><input type="radio" name="R001000" value="1"></td></tr>
<tr id="FNSR002000" role="radiogroup"><td id="textR002000">The temperature of your food</td><td><input type="radio" name="R002000" value="5"></td><td><input type="radio" name="R002000" value="4"></td><td><input type="radio" name="R002000" value="3"></td><td><input type="radio" name="R002000" value="2"></td><td><input type="radio" name="R002000" value="1"></td></tr>
</tbody></table>
<div class="FNSITEM" id="FNSR016000"><p id="textR016000">Did you experience a problem during your visit?</p>
<input type="radio" name="R016000" value="1" id="R016000.1"><label for="R016000.1">Yes</label>
<input type="radio" name="R016000" value="2" id="R016000.2"><label for="R016000.2">No</label></div>
<div class="FNSITEM" id="FNSS081000"><p id="textS081000">Please tell us why you were satisfied.</p><textarea name="S081000" maxlength="2000"></textarea></div>
<div class="FNSITEM" id="FNSR000500"><p id="textR000500">Please indicate your age.</p><select name="R000500"><option value="">-- Select --</option><option value="1">Under 25</option><option value="2">25 to 44</option><option value="9">Prefer not to answer</option></select></div>
<input type="submit" id="NextButton" value="Next"><input type="hidden" name="IoNF" value="9"><input type="hidden" name="PostedFNS" value="R001000|R002000|R016000|S081000|R000500">
</div></form></body></html>`;

describe("generic SMG question types (synthetic markup)", () => {
  const p = parseSmgPage(GRID, "https://www.mcdvoice.com/Survey.aspx?c=4");
  it("reads grid rows with column-header labels", () => {
    const speed = p.units.find((u) => u.field === "R001000");
    expect(speed.text).toBe("The speed of service");
    expect(speed.options.find((o) => o.value === "3").label).toBe("Neither Satisfied nor Dissatisfied");
    expect(scaleInfo(speed).middle.value).toBe("3");
  });
  it("defaults: ratings middle, yes/no blank, age prefer-not", () => {
    expect(defaultAnswer(p.units.find((u) => u.field === "R001000"))).toEqual({ value: "3", source: "default-middle" });
    expect(defaultAnswer(p.units.find((u) => u.field === "R016000"))).toBeNull();
    expect(defaultAnswer(p.units.find((u) => u.field === "R000500"))).toEqual({ value: "9", source: "default-prefer-not" });
    expect(requiredFallback(p.units.find((u) => u.field === "R016000"))).toMatchObject({ value: "2" });
  });
  it("decides a page with no notes and no model: only middles and prefer-not", async () => {
    const d = await decidePage({}, p, { notes: "", receipt: SAMPLE_RECEIPT });
    expect(d.answers).toEqual({ R001000: "3", R002000: "3", R000500: "9" });
  });
  it("uses model answers only when grounded in notes", async () => {
    const env = {
      AI: {
        run: async () => ({
          response: {
            answers: [
              { id: "Q2", basis: "notes", choice: "2", why: "fries were cold" },
              { id: "Q3", basis: "none", choice: "1" },
              { id: "Q4", basis: "notes", text: "My fries were cold." },
            ],
          },
        }),
      },
    };
    const d = await decidePage(env, p, { notes: "fries were cold", receipt: SAMPLE_RECEIPT });
    expect(d.answers.R002000).toBe("2");
    expect(d.answers.R001000).toBe("3");
    expect(d.answers.R016000).toBeUndefined();
    expect(d.answers.S081000).toBe("My fries were cold.");
  });
  it("ignores rating moves when there are no notes", async () => {
    const env = { AI: { run: async () => ({ response: { answers: [{ id: "Q1", basis: "notes", choice: "5" }] } }) } };
    const d = await decidePage(env, p, { notes: "", receipt: SAMPLE_RECEIPT });
    expect(d.answers.R001000).toBe("3");
  });
});

describe("finish page and helpers", () => {
  it("extracts the validation code", () => {
    const p = parseSmgPage('<html><body><div id="content"><p class="ValCode">Validation Code: 12345</p></div></body></html>', "https://www.mcdvoice.com/Finish.aspx");
    expect(p.kind).toBe("finish");
    expect(p.validationCode).toBe("12345");
  });
  it("formats and splits survey codes", () => {
    expect(formatSurveyCode("26263162211052614030000172")).toBe("26263-16221-10526-14030-00017-2");
    expect(() => splitSurveyCode("123")).toThrow();
  });
  it("scores labels", () => {
    expect(scoreLabel("Highly Satisfied")).toBe(2);
    expect(scoreLabel("Neither Satisfied nor Dissatisfied")).toBe(0);
    expect(scoreLabel("Highly Dissatisfied")).toBe(-2);
    expect(scoreLabel("Prefer not to answer")).toBe("na");
  });
  it("turns the sample receipt into facts", () => {
    expect(SAMPLE_RECEIPT.orderChannel).toBe("Mobile (app)");
    expect(SAMPLE_RECEIPT.brandId).toBe("mcdonalds");
    const f = receiptFacts(SAMPLE_RECEIPT);
    expect(f).toContain("Eat In");
    expect(f).toContain("table number 107");
    expect(f).toContain("1 x M Fry");
  });
});

describe("real mcdvoice pages from the first end-to-end run (2026-11-05)", () => {
  const page = (n) => parseSmgPage(fx(`${n}.html`), "https://www.mcdvoice.com/Survey.aspx?c=1");

  it("satisfaction grid: six rows, middle = Neither", () => {
    const p = page("mcd-grid-satisfaction");
    expect(p.units).toHaveLength(6);
    for (const u of p.units) {
      expect(u.options.map((o) => o.label)).toContain("Neither Satisfied nor Dissatisfied");
      expect(scaleInfo(u).middle.label).toBe("Neither Satisfied nor Dissatisfied");
    }
  });

  it("likelihood scale: middle = Somewhat Likely (value 3), not Likely", () => {
    const p = page("mcd-likelihood");
    expect(p.units).toHaveLength(2);
    for (const u of p.units) {
      expect(u.options.map((o) => o.label)).toEqual(["Highly Likely", "Likely", "Somewhat Likely", "Not Very Likely", "Not At All Likely"]);
      expect(scaleInfo(u).middle).toEqual({ value: "3", label: "Somewhat Likely" });
    }
  });

  it("yes/no grid labels come from the column headers", () => {
    const u = page("mcd-yesno-greet").units[0];
    expect(u.options).toEqual([
      { value: "1", label: "Yes" },
      { value: "2", label: "No" },
    ]);
    expect(defaultAnswer(u)).toBeNull(); // blank unless the site insists
  });

  it("required yes/no falls back to the no-issue answer", () => {
    const p = page("mcd-required-error");
    expect(p.errors.join(" ")).toMatch(/unanswered/i);
    const u = p.units[0];
    expect(u.text).toMatch(/Was your order accurate\?/);
    expect(requiredFallback(u)).toMatchObject({ value: "1" }); // Yes = accurate
    const problem = { kind: "radio", field: "R016000", text: "Did you experience a problem during your visit?", options: u.options };
    expect(requiredFallback(problem)).toMatchObject({ value: "2" }); // No problem
    const greet = { kind: "radio", field: "R1", text: "Did the employee greet you by name?", options: u.options };
    expect(requiredFallback(greet)).toMatchObject({ value: "2" });
  });

  it("select-all lists become one checkbox question with the legend as text", () => {
    const p = page("mcd-checkbox-accuracy-followup");
    const cb = p.units.filter((u) => u.kind === "checkbox");
    expect(cb).toHaveLength(1);
    expect(cb[0].text).toMatch(/Which of the following describes why/);
    expect(cb[0].options).toHaveLength(7);
    const cats = page("mcd-checkbox-categories").units.filter((u) => u.kind === "checkbox");
    expect(cats).toHaveLength(1);
    expect(cats[0].options.map((o) => o.label)).toContain("Beverages & Coffee");
  });

  it("comment box is a multiline text unit and stays blank without notes", async () => {
    const p = page("mcd-comment");
    expect(p.units).toEqual([expect.objectContaining({ kind: "text", field: "S079000", multiline: true, maxLength: 1200 })]);
    const d = await decidePage({}, p, { notes: "", receipt: SAMPLE_RECEIPT });
    expect(d.answers).toEqual({});
  });

  it("income question gets Prefer not to answer", () => {
    const u = page("mcd-income").units[0];
    expect(u.options.find((o) => o.value === defaultAnswer(u).value).label).toBe("Prefer not to answer");
  });

  it("finish page yields the validation code", () => {
    const p = parseSmgPage(fx("mcd-finish.html"), "https://www.mcdvoice.com/Finish.aspx?c=1");
    expect(p.kind).toBe("finish");
    expect(p.validationCode).toBe("1234567");
  });
});
