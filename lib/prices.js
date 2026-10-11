import { getManyJSON, setJSON } from "./store.js";

/* Prices come from Trolley.co.uk via the studio-amba Trolley scraper on Apify.
   Trolley's robots.txt asks bots not to use its search, so each wine is linked once
   to its Trolley product page (the person picks it in their own browser). After that,
   every check is one batched scraper run over those product pages. */
const ACTOR = "studio-amba~trolley-scraper";
const DAY = 24 * 60 * 60;
const PRICE_TTL = 1 * DAY;        // fresh prices reused for 24h
const HISTORY_MAX_POINTS = 52;    // about a year of weekly checks

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

/* ---------- Trolley links ----------
   Accepts a product URL (or shared text containing one) or a bare product code. */
export function parseTrolleyRef(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const m = s.match(/trolley\.co\.uk\/product\/([^/\s?#]+)\/([A-Za-z0-9]+)/i);
  if (m) {
    const sku = m[2].toUpperCase();
    return { sku, url: `https://www.trolley.co.uk/product/${m[1].toLowerCase()}/${sku}` };
  }
  if (/^[A-Za-z]{3}\d{3}$/.test(s)) {
    const sku = s.toUpperCase();
    return { sku, url: `https://www.trolley.co.uk/product/x/${sku}` }; // Trolley resolves by code
  }
  return null;
}

/* ---------- store names ---------- */
const STORE_MAP = [
  ["tesco", "Tesco"], ["sainsbury", "Sainsbury's"], ["asda", "ASDA"], ["waitrose", "Waitrose"],
  ["marks", "M&S"], ["m&s", "M&S"], ["ocado", "Ocado"],
  ["morrison", "Morrisons"], ["aldi", "Aldi"], ["lidl", "Lidl"],
  ["co-op", "Co-op"], ["coop", "Co-op"], ["iceland", "Iceland"], ["amazon", "Amazon"],
];
function normaliseRetailer(name) {
  const n = String(name || "").trim();
  const l = n.toLowerCase();
  for (const [needle, label] of STORE_MAP) if (l.includes(needle)) return label;
  return n || null; // keep any other shop Trolley lists, under its own name
}

const toNum = (v) => (typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.]/g, "")));

/* scraper retailers[] -> { Tesco: {stocked, price, offer, link}, ... } */
export function reshape(retailers) {
  const out = {};
  for (const r of retailers || []) {
    const label = normaliseRetailer(r.name);
    if (!label) continue;
    const price = toNum(r.price);
    if (isNaN(price) || price <= 0) continue;
    const was = toNum(r.originalPrice);
    const offer = r.promoText ? String(r.promoText).trim() : !isNaN(was) && was > price ? `Was £${was.toFixed(2)}` : null;
    if (!out[label] || price < out[label].price) {
      out[label] = { stocked: true, price, source: "trolley.co.uk", offer, link: r.outboundUrl || null };
    }
  }
  return out;
}

/* ---------- is this a good price right now? (from your own checks) ---------- */
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
function contextFor(effective, history) {
  const prior = (history || []).filter((pt) => pt.date < today()).map((pt) => pt.price);
  return prior.length >= 2 ? buildContext(effective, prior, "own") : null;
}
function addToHistory(history, effective) {
  const arr = Array.isArray(history) ? history.slice() : [];
  if (effective == null) return arr;
  const d = today();
  if (arr.length && arr[arr.length - 1].date === d) arr[arr.length - 1].price = effective; // same-day re-check
  else arr.push({ date: d, price: effective });
  return arr.slice(-HISTORY_MAX_POINTS);
}

/* One scraper run for many product pages -> { SKU: {matchedName, packSize, inStock, prices} } */
export async function fetchProducts(links) {
  if (!links.length) return {};
  const items = await runActor({ productUrls: links.map((l) => l.url), maxResults: Math.min(500, links.length) });
  const bySku = {};
  for (const it of items || []) {
    const sku = String(it.sku || (String(it.url || "").match(/\/([A-Za-z0-9]+)\/?$/) || [])[1] || "").toUpperCase();
    if (!sku) continue;
    bySku[sku] = {
      matchedName: it.productName || null,
      packSize: it.packSize || null,
      prices: reshape(it.retailers),
    };
  }
  return bySku;
}

/* ---------- main entry ----------
   wines: [{ name, trolley? }]  (trolley = product URL or code; remembered server-side once given) */
export async function getPrices(wines) {
  const seen = new Set();
  const list = [];
  for (const w of wines) {
    const name = String((w && w.name) || w || "").trim();
    if (!name || seen.has(wineKey(name))) continue;
    seen.add(wineKey(name));
    list.push({ name, key: wineKey(name), given: parseTrolleyRef(w && w.trolley) });
  }

  const [stored, priceEntries, histories] = await Promise.all([
    getManyJSON(list.map((w) => `link:${w.key}`)),
    getManyJSON(list.map((w) => `price:${w.key}`)),
    getManyJSON(list.map((w) => `hist:${w.key}`)),
  ]);

  const results = {};
  let cached = 0, needLink = 0;
  const toFetch = [];

  await Promise.all(list.map(async (w, i) => {
    let link = stored[i] && stored[i].sku ? stored[i] : null;
    if (w.given && (!link || link.sku !== w.given.sku)) {
      const changed = !!link; // a different product: its price history isn't comparable
      link = w.given;
      await setJSON(`link:${w.key}`, link); // kept indefinitely
      if (changed) { histories[i] = []; await setJSON(`hist:${w.key}`, []); }
    }
    if (!link) { results[w.name] = { needsLink: true, prices: {}, context: null }; needLink++; return; }

    const pe = priceEntries[i];
    if (pe && pe.sku === link.sku && pe.data) {
      results[w.name] = {
        link, matchedName: pe.matchedName || null, prices: pe.data,
        outOfStock: !Object.keys(pe.data).length,
        context: contextFor(bestEffective(pe.data), histories[i]),
      };
      cached++;
      return;
    }
    toFetch.push({ ...w, i, link });
  }));

  if (toFetch.length) {
    const unique = [...new Map(toFetch.map((w) => [w.link.sku, w.link])).values()];
    const bySku = await fetchProducts(unique);
    await Promise.all(toFetch.map(async (w) => {
      const p = bySku[w.link.sku];
      if (!p) {
        results[w.name] = { link: w.link, prices: {}, context: null, error: "Trolley didn't return this product. Check the link." };
        return;
      }
      const effective = bestEffective(p.prices);
      results[w.name] = {
        link: w.link, matchedName: p.matchedName, prices: p.prices,
        outOfStock: !Object.keys(p.prices).length,
        context: contextFor(effective, histories[w.i]),
      };
      const writes = [setJSON(`price:${w.key}`, { sku: w.link.sku, matchedName: p.matchedName, data: p.prices }, PRICE_TTL)];
      if (effective != null) writes.push(setJSON(`hist:${w.key}`, addToHistory(histories[w.i], effective)));
      await Promise.all(writes);
    }));
  }

  return { results, fetched: toFetch.length, cached, needLink };
}
