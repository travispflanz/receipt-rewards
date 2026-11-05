// Brand registry. Each brand says how to recognise its receipts, which survey engine runs it, and which
// "saved answers" it offers (questions about you rather than the visit, kept until you change them).
// McDonald's runs on SMG (Service Management Group); many other chains use the same platform, so
// adding one is usually a new entry here plus a check of its entry page.
//
// McDonald's saved-answer questions and option labels are copied from the live survey (run of 2026-11-05).
// Option order/values are shuffled by the site, so answers are matched by label.
export const BRANDS = [
  {
    id: "mcdonalds",
    name: "McDonald's",
    engine: "smg",
    surveyUrl: "https://www.mcdvoice.com/",
    match: /mcdvoice|mc\s?donald'?s|mcd\s?voice/i,
    codeFormat: "26 digits: 5-5-5-5-5-1",
    reward: "Buy One Get One sandwich (equal or lesser value)",
    limits: "Up to five surveys per month per restaurant; code valid 30 days.",
    profileFields: [
      {
        id: "favorite",
        label: "Favorite fast-food place",
        question: "Which of the following fast food restaurants do you consider your favorite?",
        match: /(fast[- ]?food|restaurant).*favou?rite|favou?rite.*(fast[- ]?food|restaurant)/i,
        options: [
          "McDonald’s",
          "Arby's",
          "Burger King",
          "Chick-fil-A",
          "Dunkin' Donuts",
          "Jack in the Box",
          "KFC",
          "Starbucks",
          "Subway",
          "Taco Bell",
          "Wendy's",
          "Somewhere else",
        ],
        otherOption: "Somewhere else",
      },
      {
        id: "visits",
        label: "McDonald's visits in a typical month",
        question: "Including this visit, how many times have you visited any McDonald’s in the past 30 days?",
        match: /how many times have you visited/i,
        options: ["One", "Two", "Three", "Four or more"],
      },
      {
        id: "income",
        label: "Household income",
        question: "Please indicate your annual household income:",
        match: /household income/i,
        options: [
          "Prefer not to answer",
          "Under $25,000",
          "$25,000 to $44,999",
          "$45,000 to $59,999",
          "$60,000 to $74,999",
          "$75,000 to $99,999",
          "$100,000 or more",
        ],
        hint: "Left unset, this is answered “Prefer not to answer”.",
      },
    ],
  },
];

// General sentiment categories shown under "Your visit". Each survey rating question is mapped to one
// category by its wording (order matters: "overall value for the price" is value, not overall).
export const SENTIMENT_CATEGORIES = [
  { id: "overall", label: "Overall" },
  { id: "food", label: "Food & drinks" },
  { id: "staff", label: "Staff" },
  { id: "speed", label: "Speed" },
  { id: "accuracy", label: "Order accuracy" },
  { id: "cleanliness", label: "Cleanliness" },
  { id: "value", label: "Value for money" },
  { id: "ordering", label: "Ordering (app / kiosk / counter)" },
];

export const CATEGORY_RULES = [
  ["value", /\bvalue\b|\bprice\b/i],
  ["accuracy", /accura|correct order|right order|as ordered/i],
  ["cleanliness", /clean/i],
  ["speed", /\bspeed\b|how (quickly|fast)|wait(ing)? time|time it took|\bfast\b/i],
  ["ordering", /ease of (placing|ordering)|placing your order|ordering (process|experience)|\bkiosk\b|mobile app\b/i],
  ["staff", /friendl|employee|\bstaff\b|\bcrew\b|courte|greet|helpful|manager/i],
  ["food", /\bfood\b|taste|temperature|\bfries\b|sandwich|burger|nugget|\bdrinks?\b|beverage|coffee|\bmeal\b|soft drink|\bquality of your\b/i],
  ["overall", /overall|recommend|return to|\btrust\b|experience|\bvisit\b|likel/i],
];

export const categoryOf = (text) => CATEGORY_RULES.find(([, re]) => re.test(text || ""))?.[0] || null;

export const brandById = (id) => BRANDS.find((b) => b.id === id) || null;
export const detectBrand = (text) => BRANDS.find((b) => b.match.test(text || "")) || null;

/** Public (JSON-safe) view of a brand for the UI. */
export const brandPublic = (b) => ({
  id: b.id,
  name: b.name,
  codeFormat: b.codeFormat,
  reward: b.reward,
  limits: b.limits,
  profileFields: (b.profileFields || []).map(({ id, label, question, options, otherOption, hint }) => ({ id, label, question, options, otherOption, hint })),
});
