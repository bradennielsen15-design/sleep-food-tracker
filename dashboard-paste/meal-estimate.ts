// POST /meal-estimate  { text?, imageBase64?, imageMime? }
//   -> { status:"ok", calories, protein_g, carbs_g, fat_g,
//        confidence:"low"|"medium"|"high", uncertainty_note,
//        known_panel:boolean, panel_name? }
//   or { status:"unavailable", error:"AI unavailable" } (HTTP 503)
//   or { status:"error", code, message } (HTTP 4xx/5xx)
//
// Auth: Verify JWT is OFF for this function on purpose (same reason as
// Saddle). The function checks the caller's session itself: it takes the
// Bearer access token, asks Supabase Auth (/auth/v1/user) who it belongs
// to, and rejects the request with 401 when the token is missing or bad.
// It never trusts anything in the request body for identity.
//
// Secrets: GEMINI_API_KEY and GEMINI_MODEL come only from Deno.env (the
// project-wide secrets Saddle already uses). No key, token, or personal
// health data lives in this file.
//
// Honesty rules (baked in, not suggestions):
// - A meal matching a VERIFIED_PANELS entry uses that panel exactly.
// - A BRANDED product NOT in VERIFIED_PANELS is never given an invented
//   panel: the answer is a generic estimate, confidence "low", with an
//   uncertainty note saying the panel is unknown and the user should
//   correct it.
// - If Gemini fails, is out of quota, or returns nothing usable, the
//   answer is { status:"unavailable" } with HTTP 503. Numbers are never
//   invented on failure.
// - This function estimates macros only. It never gives medical advice,
//   diet prescriptions, or bedtime recommendations.
//
// This file is self-contained on purpose (no cross-file imports), so the
// identical file can be pasted into the Supabase dashboard editor. The
// copy in dashboard-paste/meal-estimate.ts is the same code.

// ------------------------------------------------------------------ env

function env(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  const v = d?.env?.get?.(name);
  return v && String(v).trim() ? String(v).trim() : undefined;
}

// ------------------------------------------------------------------ http

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (msg: string) => new HttpError(400, "bad_request", msg);
export const unauth = (msg: string) => new HttpError(401, "bad_session", msg);

const GITHUB_PAGES_ORIGIN = /^https:\/\/[a-z0-9][a-z0-9-]*\.github\.io$/i;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/** Only the GitHub Pages app origin pattern and localhost get CORS. */
export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const base: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && (GITHUB_PAGES_ORIGIN.test(origin) || LOCAL_ORIGIN.test(origin))) {
    base["Access-Control-Allow-Origin"] = origin;
  } else if (!origin) {
    // Non-browser callers (curl, server checks) send no Origin.
    base["Access-Control-Allow-Origin"] = "*";
  }
  // Any other Origin gets no Access-Control-Allow-Origin: the browser
  // blocks it, which is the intended behaviour.
  return base;
}

export function jsonFor(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------------ auth
// Same approach as Saddle's _shared/db.ts requireUser, inlined here.

function supabaseBaseUrl(): string {
  const u = env("SUPABASE_URL");
  if (!u) throw new HttpError(500, "not_configured", "The server is missing its Supabase address.");
  return u.replace(/\/$/, "");
}

/** The powerful key. It only ever exists inside the function. */
function serviceKey(): string {
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const dict = env("SUPABASE_SECRET_KEYS");
  if (dict) {
    try {
      const o = JSON.parse(dict);
      const k = o.default || Object.values(o)[0];
      if (k) return String(k);
    } catch { /* fall through */ }
  }
  const single = env("SUPABASE_SECRET_KEY");
  if (single) return single;
  throw new HttpError(500, "not_configured", "The server is missing its database key.");
}

/** Who is asking? Checks the sign-in token with Supabase Auth. */
export async function requireUser(req: Request): Promise<string> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw unauth("Please sign in again so the estimate can be checked.");
  const r = await fetchWithTimeout(`${supabaseBaseUrl()}/auth/v1/user`, {
    headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` },
  }, 10000);
  if (!r.ok) throw unauth("Your sign-in ran out. Please sign in again.");
  const u = await r.json();
  if (!u?.id) throw unauth("Your sign-in could not be checked.");
  return String(u.id);
}

// ------------------------------------------------------------------ panels
// Generic food definitions, safe to keep in a public repo. Values are per
// the serving shown. Drink panels: the source list specified calories
// (and caffeine where shown); remaining macros are the label-typical
// values — if a label differs, the user corrects the entry, and the
// panel here should be corrected too.

export interface Panel {
  name: string;
  serving: string;
  keywords: string[];
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export const VERIFIED_PANELS: Panel[] = [
  { name: "Muscle Milk Pro33 Cookies 'N Crème", serving: "11 oz carton", keywords: ["muscle milk", "pro33", "pro 33"], calories: 190, protein_g: 33, carbs_g: 11, fat_g: 1 },
  { name: "Ascent 100% Whey Vanilla Bean", serving: "1 scoop", keywords: ["ascent"], calories: 120, protein_g: 25, carbs_g: 2, fat_g: 1 },
  { name: "Silk Organic Unsweet Almond", serving: "1 cup", keywords: ["silk"], calories: 40, protein_g: 1, carbs_g: 1, fat_g: 3 },
  { name: "Kirkland Grilled Chipotle Chicken", serving: "60 g", keywords: ["kirkland", "grilled chipotle chicken"], calories: 80, protein_g: 13, carbs_g: 2, fat_g: 2 },
  { name: "Amylu Cranberry & Jalapeño Chicken Meatballs", serving: "4 meatballs (87 g)", keywords: ["amylu", "cranberry & jalapeño", "cranberry jalapeno"], calories: 160, protein_g: 14, carbs_g: 8, fat_g: 8 },
  { name: "ONE Maple Glazed Doughnut", serving: "1 bar", keywords: ["one maple glazed doughnut", "maple glazed doughnut"], calories: 230, protein_g: 20, carbs_g: 23, fat_g: 8 },
  { name: "ONE Chocolate Chip Cookie Dough", serving: "1 bar", keywords: ["one chocolate chip cookie dough", "chocolate chip cookie dough protein bar"], calories: 230, protein_g: 20, carbs_g: 23, fat_g: 8 },
  { name: "Ratio Protein yogurt", serving: "1 container", keywords: ["ratio protein"], calories: 170, protein_g: 25, carbs_g: 8, fat_g: 3 },
  { name: "BodyArmor Lyte", serving: "20 oz bottle", keywords: ["bodyarmor lyte", "body armor lyte"], calories: 25, protein_g: 0, carbs_g: 6, fat_g: 0 },
  { name: "Bloom Sparkling Energy", serving: "1 can", keywords: ["bloom sparkling energy", "bloom energy"], calories: 10, protein_g: 0, carbs_g: 2, fat_g: 0 },
  { name: "Celsius Sparkling", serving: "1 can", keywords: ["celsius"], calories: 10, protein_g: 0, carbs_g: 2, fat_g: 0 },
  { name: "Taylor Farms Sweet Kale Chopped Kit", serving: "1 cup", keywords: ["taylor farms", "sweet kale"], calories: 170, protein_g: 10, carbs_g: 17, fat_g: 3 },
  { name: "Realgood Chicken & Pepper Jack Burrito", serving: "1 burrito", keywords: ["realgood", "pepper jack burrito"], calories: 450, protein_g: 37, carbs_g: 33, fat_g: 28 },
];

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

export function findPanel(text: string): Panel | null {
  const t = normalizeText(text);
  for (const p of VERIFIED_PANELS) {
    for (const k of p.keywords) {
      if (t.includes(normalizeText(k))) return p;
    }
  }
  return null;
}

/** A leading "2 cartons / 2 scoops / 2 bars ..." scales the panel. */
export function panelQuantity(text: string): number {
  const m = normalizeText(text).match(/(\d+(?:\.\d+)?)\s+(cartons?|scoops?|bars?|cups?|bottles?|cans?|servings?|containers?|packs?)\b/);
  if (!m) return 1;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 20 ? n : 1;
}

// ------------------------------------------------------------------ gemini

export class GeminiUnavailable extends Error {}

// deno-lint-ignore no-explicit-any
export type Json = any;

export function extractText(resp: Json): string {
  const parts = resp?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p: Json) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
}

export function parseLooseJson(text: string): Json {
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch { /* try to find the braces */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("Gemini did not return JSON");
}

export interface Estimate {
  status: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  confidence: "low" | "medium" | "high";
  uncertainty_note: string;
  known_panel: boolean;
  panel_name?: string;
}

function panelListForPrompt(): string {
  return VERIFIED_PANELS.map((p) =>
    `- ${p.name} (${p.serving}): ${p.calories} cal, ${p.protein_g}g protein, ${p.carbs_g}g carbs, ${p.fat_g}g fat`).join("\n");
}

const SYSTEM_PROMPT = `You estimate calories and macros for food. Reply with JSON ONLY, no other text, in exactly this shape:
{"calories": number, "protein_g": number, "carbs_g": number, "fat_g": number, "confidence": "low"|"medium"|"high", "uncertainty_note": string, "known_panel": boolean, "panel_name": string or null}

Rules:
- VERIFIED PANELS (use these values exactly when the food matches one, and set known_panel true and panel_name to the panel name):
${panelListForPrompt()}
- If the food is a BRANDED product that is NOT in the verified list above, NEVER invent its nutrition panel. Give a generic estimate for a similar food, set known_panel false, confidence "low", and write uncertainty_note saying the product's panel is unknown and the user should correct it.
- For unbranded, ordinary food, estimate from general nutrition knowledge and set confidence honestly (low when the portion or contents are unclear).
- Say what is uncertain in uncertainty_note. Keep it to one short sentence.
- Never give medical advice, diet prescriptions, or bedtime recommendations. Estimate macros only.`;

/** Ask Gemini for one JSON estimate. Throws GeminiUnavailable on any failure. */
export async function askGemini(parts: Json[]): Promise<Json> {
  const key = env("GEMINI_API_KEY");
  const model = env("GEMINI_MODEL") || "gemini-2.5-flash";
  if (!key) throw new GeminiUnavailable("Gemini is not set up yet.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let r: Response;
  try {
    r = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
      }),
    }, 15000);
  } catch {
    throw new GeminiUnavailable("Gemini could not be reached");
  }
  if (!r.ok) throw new GeminiUnavailable(`Gemini answered ${r.status}`);
  const text = extractText(await r.json());
  if (!text) throw new GeminiUnavailable("Gemini sent nothing back");
  try {
    return parseLooseJson(text);
  } catch {
    throw new GeminiUnavailable("Gemini's answer was not readable");
  }
}

/**
 * Validate and normalise a Gemini answer. A claimed known panel is only
 * honoured when its name is actually in VERIFIED_PANELS (then the exact
 * panel values win); anything else claiming a panel is downgraded to a
 * low-confidence generic estimate instead of being passed through.
 */
export function validateEstimate(raw: Json): Estimate {
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const conf = raw?.confidence === "high" || raw?.confidence === "medium" ? raw.confidence : "low";
  const note = typeof raw?.uncertainty_note === "string" && raw.uncertainty_note.trim()
    ? raw.uncertainty_note.trim()
    : "Estimate only — portion and preparation were not fully specified.";
  const claimed = typeof raw?.panel_name === "string" ? raw.panel_name.trim() : "";
  const panel = claimed
    ? VERIFIED_PANELS.find((p) => normalizeText(p.name) === normalizeText(claimed)) || null
    : null;
  if (raw?.known_panel === true && panel) {
    return {
      status: "ok",
      calories: panel.calories, protein_g: panel.protein_g,
      carbs_g: panel.carbs_g, fat_g: panel.fat_g,
      confidence: "high",
      uncertainty_note: `Matched verified panel: ${panel.name} (${panel.serving}).`,
      known_panel: true, panel_name: panel.name,
    };
  }
  if (raw?.known_panel === true && !panel) {
    // Claimed a panel that does not exist here: never pass it through.
    return {
      status: "ok",
      calories: num(raw?.calories), protein_g: num(raw?.protein_g),
      carbs_g: num(raw?.carbs_g), fat_g: num(raw?.fat_g),
      confidence: "low",
      uncertainty_note: "This product's panel is unknown — the estimate is generic, please correct it.",
      known_panel: false,
    };
  }
  return {
    status: "ok",
    calories: num(raw?.calories), protein_g: num(raw?.protein_g),
    carbs_g: num(raw?.carbs_g), fat_g: num(raw?.fat_g),
    confidence: conf, uncertainty_note: note, known_panel: false,
  };
}

export async function estimateMeal(input: { text?: string; imageBase64?: string; imageMime?: string }): Promise<Estimate> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  // A text match against a verified panel never needs a model call: the
  // panel values are exact, and skipping the call saves free-tier quota.
  if (text) {
    const panel = findPanel(text);
    if (panel) {
      const q = panelQuantity(text);
      return {
        status: "ok",
        calories: panel.calories * q, protein_g: panel.protein_g * q,
        carbs_g: panel.carbs_g * q, fat_g: panel.fat_g * q,
        confidence: "high",
        uncertainty_note: q > 1
          ? `Matched verified panel: ${panel.name} (${panel.serving}) x ${q}.`
          : `Matched verified panel: ${panel.name} (${panel.serving}).`,
        known_panel: true, panel_name: panel.name,
      };
    }
  }
  const parts: Json[] = [];
  if (text) {
    parts.push({ text: `Estimate calories and macros for this food, described as: ${text}` });
  }
  if (input.imageBase64) {
    parts.push({ text: "Estimate calories and macros for the food shown in this photo. If a branded product is visible, name it in panel_name only when it is in the verified list; otherwise say its panel is unknown." });
    parts.push({ inlineData: { mimeType: input.imageMime || "image/jpeg", data: input.imageBase64 } });
  }
  if (!parts.length) throw bad("Describe the food or send a photo of it.");
  const raw = await askGemini(parts);
  return validateEstimate(raw);
}

// ------------------------------------------------------------------ handler

export async function handleMealEstimate(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeadersFor(req) });
  if (req.method !== "POST") {
    return jsonFor(req, { status: "error", code: "method_not_allowed", message: "Please send a POST request." }, 405);
  }
  let body: Record<string, unknown> = {};
  try {
    const t = await req.text();
    body = t ? JSON.parse(t) : {};
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
  } catch {
    return jsonFor(req, { status: "error", code: "bad_json", message: "That request was not readable. Please try again." }, 400);
  }
  try {
    await requireUser(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
    const imageMime = typeof body.imageMime === "string" ? body.imageMime.trim() : "";
    if (!text && !imageBase64) throw bad("Describe the food or send a photo of it.");
    if (text.length > 4000) throw bad("That description is a bit long. Please shorten it.");
    if (imageBase64.length > 12_000_000) throw bad("That photo is too large. Please send a smaller one.");
    if (imageBase64 && !/^[A-Za-z0-9+/=]+$/.test(imageBase64)) throw bad("That photo data was not readable.");
    const out = await estimateMeal({ text: text || undefined, imageBase64: imageBase64 || undefined, imageMime: imageMime || undefined });
    return jsonFor(req, out);
  } catch (e) {
    if (e instanceof GeminiUnavailable) {
      // Honest failure: never invent numbers when the AI is unavailable.
      return jsonFor(req, { status: "unavailable", error: "AI unavailable" }, 503);
    }
    if (e instanceof HttpError) {
      return jsonFor(req, { status: "error", code: e.code, message: e.message }, e.status);
    }
    console.error("Unexpected error:", e instanceof Error ? e.stack || e.message : e);
    return jsonFor(req, { status: "error", code: "server_error", message: "Something went wrong on our side. Nothing was saved." }, 500);
  }
}

// Deno.serve only exists in the Supabase runtime. The guard keeps this
// file importable (and testable) in plain Node, where Deno is absent or
// stubbed without serve.
// deno-lint-ignore no-explicit-any
const denoRuntime = (globalThis as any).Deno;
if (denoRuntime && typeof denoRuntime.serve === "function") {
  denoRuntime.serve(handleMealEstimate);
}
