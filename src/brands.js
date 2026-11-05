// Brand registry. Each brand says how to recognise its receipts and which survey engine runs it.
// McDonald's runs on SMG (Service Management Group); many other chains use the same platform, so
// adding one is usually a new entry here plus a check of its entry page.
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
  },
];

export const brandById = (id) => BRANDS.find((b) => b.id === id) || null;
export const detectBrand = (text) => BRANDS.find((b) => b.match.test(text || "")) || null;
