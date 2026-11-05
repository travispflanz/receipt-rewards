# Receipt Rewards

Take a photo of a restaurant receipt (or upload one), type or dictate a few notes, and a Cloudflare Worker
completes the receipt's customer-satisfaction survey and hands back the reward validation code.

Live: https://receipt-rewards.travis-097.workers.dev (passcode protected)

Supported now: **McDonald's** (mcdvoice.com, "Buy One Get One" sandwich offer). Other chains plug in through
`src/brands.js`; many of them run on the same SMG survey platform the engine already speaks.

## How it works

1. **Read the receipt** — the browser shrinks the photo, `/api/extract` sends it to a Workers AI vision model
   (`VISION_MODEL`), which returns the survey code, date/time, order type, items, table number, etc. The app tries
   other rotations automatically if the code isn't found, and the code can always be typed in.
2. **Start a run** — `/api/runs` saves the run in D1 and starts a Cloudflare Workflow (`SurveyRun`).
3. **Complete the survey** — the Workflow talks to the survey site over plain HTTPS like a browser (cookies,
   redirects, form posts). Each survey page is two durable steps: *plan* (parse the page, decide answers) and
   *submit*. Every page's raw HTML is stored in D1, so a finished page and its code are never lost.
4. **Answer policy** (`src/answer.js`), in order of precedence
   - **Saved answers** (per restaurant, kept until changed): McDonald's favorite fast-food place, visits in the past
     30 days, household income. Matched to the survey's options by label (the site shuffles their order).
   - **Notes**: a text model (`TEXT_MODEL`) reads them and may move a rating only for the aspect they mention; it must
     cite the notes (`basis: "notes"`), otherwise its answer is ignored.
   - **Your visit ratings** (optional 1–5 faces): Overall, Food & drinks, Staff, Speed, Order accuracy, Cleanliness,
     Value, Ordering. Each survey rating question is mapped to a category by its wording (`CATEGORY_RULES` in
     `src/brands.js`); unrated categories use Overall; "Any problems?" and the accuracy rating answer the matching
     yes/no questions.
   - Ratings with nothing above default to the **middle** option (e.g. "Neither satisfied nor dissatisfied",
     "Somewhat likely").
   - Factual questions (how you ordered, dine-in vs carry-out, items) come from the receipt.
   - Everything else is left blank ("no preference"); demographics get "Prefer not to answer"; contact/sweepstakes
     get "No". If the site insists on an answer, the most neutral option is used.
   - Comment boxes are only filled from your own notes. Names, emails and phone numbers are never entered.
5. **Result** — the validation code shows in the app and in "Recent codes".

Optional **review mode** pauses before each page is submitted so you can approve it.

## Stack

Cloudflare Workers (Free plan friendly: every step stays under 10 ms CPU), Workflows, D1, Workers AI.
The UI is one HTML file (`src/ui.html`) bundled into the Worker. No browser automation needed.

## CI/CD

- GitHub Actions (`.github/workflows/ci.yml`): tests + dry-run build on every push/PR.
- Cloudflare Workers Builds is connected to this repo: pushes to `main` run `npm test` and `npx wrangler deploy`.
- Secret (set once in Cloudflare, kept across deploys): `APP_PASSCODE`.

## API

| Method | Path | |
|---|---|---|
| POST | `/api/extract` | `{image: dataURL}` → receipt fields |
| POST | `/api/runs` | `{surveyCode, receipt, notes, brandId, review, sentiment, problem}` → `{id}` |
| GET/PUT | `/api/profile/:brand` | saved answers `{values}` |
| GET | `/api/runs/:id` | status, stage, per-page decisions, validation code |
| POST | `/api/runs/:id/review` | `{page, action: "approve" \| "abort", overrides}` |
| GET | `/api/runs/:id/pages[/:seq]` | stored survey pages (debugging) |

All `/api/*` calls need the `x-passcode` header.

## Adding a restaurant

Add an entry to `src/brands.js` (name, survey URL, receipt match). If its survey runs on SMG (look for
`Survey.aspx` forms and `FNSITEM` question blocks), the existing engine handles it; otherwise add an engine
next to `src/smg.js` and route to it in `src/workflow.js`.
