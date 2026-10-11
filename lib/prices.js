import { getJSON, getManyJSON, setJSON } from "./store.js";

const ACTOR = "crawlerbros~trolley-grocery-price-scraper";
const DAY = 24 * 60 * 60;
const PRICE_TTL = 1 * DAY;        // fresh prices reused for 24h
const ID_TTL = 90 * DAY;          // wine name -> Trolley product id
const NOT_FOUND_TTL = 7 * DAY;    // remember "Trolley doesn't list this" for a week
const HISTORY_MAX_POINTS = 52;    // about a year of weekly checks
const SEARCH_CONCURRENCY = 3;     // parallel Apify searches for newly added wines

const today = () => new Date().toISOString().slice(0, 10);
export const wineKey = (name) => String(name).trim().toLowerCase();

/* ---------- Apify ---------- */
export async function runActor(input) {
  const token = (process.env.APIFY_TOKEN || "").trim(); // tolerate stray spaces/newlines from pasting
  if (!token) throw new Error("APIFY_TOKEN is not set in Vercel environment variables");
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Apify ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

/* ---------- store names ---------- */
const STORE_MAP = [
  ["tesco", "Tesco"], ["sainsbury", "Sainsbury's"], ["asda", "ASDA"], ["waitrose", "Waitrose"],
  ["ocado", "M&S"], ["marks", "M&S"], ["m&s", "M&S"], // M&S groceries sell via Ocado
  ["morrison", "Morrisons"], ["aldi", "Aldi"], ["lidl", "Lidl"],
  ["co-op", "Co-op"], ["coop", "Co-op"], ["iceland", "Iceland"], ["amazon", "Amazon"],
];
function normaliseRetailer(name) {
  const n = String(name || "").toLowerCase();
  for (const [needle, label] of STORE_MAP) if (n.includes(needle)) return label;
  return null;
}

/* ---------- product matching (prefer the standard 75cl bottle) ---------- */
const VARIANT_WORDS = ["the pale", "the beach", "rock angel", "magnum", "limited edition", "gift", "jeroboam", "personalised", "case of"];
const SMALL_FORMATS = ["37.5cl", "18.7cl", "187ml", "25cl", "20cl", "half"];
const LARGE_FORMATS = ["150cl", "100cl", "1.5l", "1.5 l", "3l", "3 l", "magnum", "jeroboam", "double magnum"];

export function pickBest(items, wineName) {
  const ql = wineName.toLowerCase();
  const terms = ql.split(/\s+/).filter((w) => w.length > 1);
  let best = null, bestScore = -1;
  for (const it of items || []) {
    const name = String(it.name || "").toLowerCase();
    const brand = String(it.brand || "").toLowerCase();
    const desc = String(it.description || "").toLowerCase();
    const size = String(it.size || "").toLowerCase();
    const hay = `${brand} ${name} ${desc}`;

    if (!size.includes("cl")) continue;                 // wine bottles are in cl on Trolley -> filters cosmetics
    if (!terms.every((w) => hay.includes(w))) continue;  // all query words present across brand+name+desc

    let score = 100;
    if (size.includes("75cl") || size.includes("750ml")) score += 30;
    for (const sf of SMALL_FORMATS) if (size.includes(sf) && !ql.includes(sf)) score -= 70;
    for (const lf of LARGE_FORMATS) if ((size.includes(lf) || hay.includes(lf)) && !ql.includes(lf)) score -= 70;
    for (const vw of VARIANT_WORDS) if (hay.includes(vw) && !ql.includes(vw)) score -= 45;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 0 ? best : null;
}

/* Apify storePrices[] -> { Tesco: {stocked, price, offer}, ... } */
export function reshape(storePrices) {
  const out = {};
  for (const sp of storePrices || []) {
    const r = normaliseRetailer(sp.store);
    if (!r) continue;
    const price = typeof sp.price === "number" ? sp.price : parseFloat(String(sp.price).replace(/[^\d.]/g, ""));
    if (isNaN(price) || price <= 0) continue;
    if (!out[r] || price < out[r].price) {
      out[r] = { stocked: true, price, source: "trolley.co.uk", offer: sp.promotionalOffer || null };
    }
  }
  return out;
}

/* ---------- is this a good price right now? ----------
   Prefers our own log of prices seen on your checks. Falls back to Trolley's
   priceHistory, which spot checks showed is usually right but occasionally
   wildly off, so anything implausible versus today's price is ignored. */
function offerPrice(p) {
  if (!p || typeof p.offer !== "string" || !p.offer) return null;
  let m = p.offer.match(/(\d+)\s*for\s*£\s*([\d.]+)/i);
  if (m) { const n = parseInt(m[1], 10), tot = parseFloat(m[2]); if (n > 0 && tot > 0) return +(tot / n).toFixed(2); }
  m = p.offer.match(/£\s*([\d.]+)/);
  if (m) { const v = parseFloat(m[1]); if (v > 0) return v; }
  return null;
}
function effectivePrice(p) {
  const base = typeof p.price === "number" && !isNaN(p.price) ? p.price : Infinity;
  const op = offerPrice(p);
  return op != null && op < base ? op : base;
}
export function bestEffective(pricesMap) {
  let best = Infinity;
  for (const r in pricesMap || {}) {
    const p = pricesMap[r];
    if (!p || !p.stocked) continue;
    best = Math.min(best, effectivePrice(p));
  }
  return isFinite(best) ? best : null;
}
export function buildContext(current, historyNumbers, basis) {
  if (current == null || !historyNumbers || historyNumbers.length < 2) return null;
  const avg = historyNumbers.reduce((a, b) => a + b, 0) / historyNumbers.length;
  const low = Math.min(...historyNumbers);
  if (avg <= 0) return null;
  const ratio = current / avg;
  if (ratio < 0.25 || ratio > 4) return null; // doesn't add up -> say nothing rather than guess

  let label = null;
  if (current < low) label = "Lowest seen yet";
  else if (current <= low * 1.03) label = "Near lowest seen";
  else if (current <= avg * 0.92) label = "Below average";
  else if (current >= avg * 1.12) label = "Higher than usual";
  if (!label) return null;
  return { label, basis, avg: Math.round(avg * 100) / 100, low: Math.round(low * 100) / 100, points: historyNumbers.length };
}

function contextFor(effective, history, apifyHistory) {
  const prior = (history || []).filter((pt) => pt.date < today()).map((pt) => pt.price);
  let ctx = prior.length >= 2 ? buildContext(effective, prior, "own") : null;
  if (!ctx && apifyHistory && apifyHistory.length >= 2) ctx = buildContext(effective, apifyHistory, "apify");
  return ctx;
}

function addToHistory(history, effective) {
  const arr = Array.isArray(history) ? history.slice() : [];
  if (effective == null) return arr;
  const d = today();
  if (arr.length && arr[arr.length - 1].date === d) arr[arr.length - 1].price = effective; // same-day re-check
  else arr.push({ date: d, price: effective });
  return arr.slice(-HISTORY_MAX_POINTS);
}

/* ---------- Apify lookups ---------- */
export async function resolveProductId(wineName) {
  const items = await runActor({ mode: "search", searchQuery: wineName, sortOrder: "relevance", maxItems: 12 });
  const best = pickBest(items, wineName);
  return best ? { productId: best.productId, matchedName: best.name } : null;
}

export async function fetchPricesForIds(idList) {
  if (!idList.length) return {};
  const items = await runActor({ mode: "byProductIds", productIds: idList });
  const byId = {};
  for (const it of items || []) {
    if (!it.productId) continue;
    byId[it.productId] = {
      prices: reshape(it.storePrices),
      apifyHistory: Array.isArray(it.priceHistory)
        ? it.priceHistory.map((h) => h.price).filter((p) => typeof p === "number" && p > 0)
        : [],
    };
  }
  return byId;
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/* ---------- main entry: prices for a list of wine names ---------- */
export async function getPrices(names) {
  const unique = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  const keys = unique.map(wineKey);

  const [priceEntries, idEntries, histories] = await Promise.all([
    getManyJSON(keys.map((k) => `price:${k}`)),
    getManyJSON(keys.map((k) => `id:${k}`)),
    getManyJSON(keys.map((k) => `hist:${k}`)),
  ]);

  const results = {};
  let cached = 0;
  const needId = [];
  const needPrice = [];

  unique.forEach((name, i) => {
    const pe = priceEntries[i];
    if (pe && pe.data && Object.keys(pe.data).length) {
      results[name] = { prices: pe.data, context: contextFor(bestEffective(pe.data), histories[i], pe.apifyHistory) };
      cached++;
      return;
    }
    const ide = idEntries[i];
    if (ide && ide.productId) needPrice.push({ name, i, productId: ide.productId });
    else if (ide && ide.notFound) results[name] = null; // searched recently, Trolley doesn't list it
    else needId.push({ name, i });
  });

  // First-time wines: find their Trolley product (a few at a time)
  const resolved = await inBatches(needId, SEARCH_CONCURRENCY, async (w) => {
    try { return { w, r: await resolveProductId(w.name) }; }
    catch (e) { return { w, r: null, error: e.message }; }
  });
  for (const { w, r, error } of resolved) {
    if (r) {
      await setJSON(`id:${keys[w.i]}`, r, ID_TTL);
      needPrice.push({ name: w.name, i: w.i, productId: r.productId });
    } else if (error) {
      results[w.name] = { prices: {}, context: null, error }; // temporary failure: try again next check
    } else {
      await setJSON(`id:${keys[w.i]}`, { notFound: true }, NOT_FOUND_TTL); // don't pay to re-search for a week
      results[w.name] = null;
    }
  }

  // One batched price call for everything that needs fresh prices
  if (needPrice.length) {
    const priceMap = await fetchPricesForIds([...new Set(needPrice.map((n) => n.productId))]);
    await Promise.all(needPrice.map(async (n) => {
      const entry = priceMap[n.productId];
      const prices = entry && entry.prices;
      if (!prices || !Object.keys(prices).length) { results[n.name] = null; return; } // not cached -> retried next time
      const effective = bestEffective(prices);
      const context = contextFor(effective, histories[n.i], entry.apifyHistory);
      results[n.name] = { prices, context };
      await Promise.all([
        setJSON(`price:${keys[n.i]}`, { data: prices, apifyHistory: entry.apifyHistory }, PRICE_TTL),
        setJSON(`hist:${keys[n.i]}`, addToHistory(histories[n.i], effective)),
      ]);
    }));
  }

  return { results, fetched: needPrice.length, cached };
}
