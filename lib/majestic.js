import { getJSON, setJSON } from "./store.js";

/* Majestic prices via Google Shopping (SerpApi).
   Majestic's own site sits behind a bot wall that turns away cloud servers, so instead
   we ask Google Shopping (UK) for the wine and keep only a result sold by Majestic whose
   title matches the wine. Needs a SERPAPI_KEY environment variable (free plan: 250
   searches a month). Results are cached, and a monthly counter keeps us inside the plan. */

const DAY = 24 * 60 * 60;
const FOUND_TTL = 1 * DAY;      // a Majestic price, reused for 24h
const NONE_TTL = 7 * DAY;       // "Majestic doesn't list this", rechecked weekly
const MONTHLY_LIMIT = Number(process.env.SERPAPI_MONTHLY_LIMIT) || 230; // leave headroom under the free 250

const key = () => (process.env.SERPAPI_KEY || "").trim();
export const majesticEnabled = () => !!key();

const plain = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const STOP = new Set(["the", "de", "du", "la", "le", "les", "del", "di", "da", "and", "et", "y", "of", "wine", "wines", "75cl", "750ml", "majestic"]);
const terms = (t) => plain(t).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^(19|20)\d\d$/.test(w));

// "https://www.majestic.co.uk/wines/whispering-angel-rose-08001" -> "whispering angel rose"
export function majesticNameFromUrl(url) {
  const m = String(url || "").match(/majestic\.co\.uk\/[a-z-]+\/([a-z0-9-]+?)(?:-\d{3,})?\/?(?:[?#]|$)/i);
  return m ? m[1].replace(/-/g, " ") : null;
}

const VARIANT = /\b(magnum|jeroboam|half bottle|37\.?5\s?cl|150\s?cl|1\.5\s?l|case of|x\s?6|6\s?x|mixed|gift|personalised|bag in box|\d+\s?bottles?)\b/i;

/* Pick Majestic's listing for this wine from Google Shopping results (or null). */
export function pickMajestic(results, wineName) {
  const want = terms(wineName);
  if (!want.length) return null;
  let best = null, bestScore = -1;
  for (const r of results || []) {
    if (!/majestic/i.test(String(r.source || ""))) continue;
    const price = typeof r.extracted_price === "number" ? r.extracted_price : parseFloat(String(r.price || "").replace(/[^\d.]/g, ""));
    if (!(price > 0)) continue;
    const title = plain(r.title);
    const have = want.filter((w) => title.includes(w)).length;
    if (have < want.length) continue;           // every meaningful word of the wine's name must appear
    if (VARIANT.test(title) && !VARIANT.test(plain(wineName))) continue;
    const score = 100 - Math.abs(terms(r.title).length - want.length); // closest title wins
    if (score > bestScore) { bestScore = score; best = { title: r.title, price, oldPrice: r.extracted_old_price || null }; }
  }
  return best;
}

async function underMonthlyLimit() {
  const month = new Date().toISOString().slice(0, 7);
  const k = `serpapi:${month}`;
  const n = (await getJSON(k).catch(() => null)) || 0;
  if (n >= MONTHLY_LIMIT) return false;
  await setJSON(k, n + 1, 40 * DAY).catch(() => {});
  return true;
}

export async function searchShopping(q) {
  const params = new URLSearchParams({ engine: "google_shopping", q, gl: "uk", hl: "en", google_domain: "google.co.uk", location: "United Kingdom", api_key: key() });
  const res = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(25000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    if (/hasn't returned any results/i.test(j.error || "")) return [];
    throw new Error(`Google Shopping lookup failed: ${j.error || `HTTP ${res.status}`}`);
  }
  return j.shopping_results || [];
}

/* -> { price, offer, title, link } | null, or throws on a lookup problem.
   majesticUrl (optional) is a Majestic product link the user pasted: its name is used for
   matching, and it becomes the link the app opens. */
export async function majesticPrice(wineName, majesticUrl) {
  if (!majesticEnabled()) return null;
  const name = majesticNameFromUrl(majesticUrl) || wineName;
  const cacheKey = `mj:${plain(name).trim()}`;
  const cached = await getJSON(cacheKey).catch(() => null);
  let hit;
  if (cached) hit = cached.none ? null : cached;
  else {
    if (!(await underMonthlyLimit())) throw new Error("Monthly Google Shopping allowance used up; Majestic prices resume next month");
    const results = await searchShopping(`${name} Majestic`);
    hit = pickMajestic(results, name);
    await setJSON(cacheKey, hit || { none: true }, hit ? FOUND_TTL : NONE_TTL).catch(() => {});
  }
  if (!hit) return null;
  return {
    price: hit.price,
    offer: hit.oldPrice && hit.oldPrice > hit.price ? `Was £${Number(hit.oldPrice).toFixed(2)}` : null,
    title: hit.title,
    link: majesticUrl || `https://www.majestic.co.uk/search?q=${encodeURIComponent(name)}`,
  };
}
