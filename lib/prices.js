import { getManyJSON, setJSON } from "./store.js";

/* Prices come from Trolley.co.uk product pages, read directly.
   Trolley's robots.txt allows product pages but asks bots not to use its search, so each
   wine is linked once to its product page (the person picks it in their own browser).
   After that, a check is one small page fetch per wine: no scraping service, no API costs. */
const DAY = 24 * 60 * 60;
const PRICE_TTL = 1 * DAY;        // fresh prices reused for 24h
const HISTORY_MAX_POINTS = 52;    // about a year of weekly checks
const FETCH_CONCURRENCY = 3;      // be polite: a few pages at a time
const USER_AGENT = "Mozilla/5.0 (compatible; CellarPriceWatch/1.0; personal weekly wine price check)";

const today = () => new Date().toISOString().slice(0, 10);
export const wineKey = (name) => String(name).trim().toLowerCase();

/* ---------- reading a Trolley product page ---------- */
const decode = (t) => String(t || "")
  .replace(/&pound;/g, "£").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;|&rsquo;/g, "'")
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/\\'/g, "'");
const text = (t) => decode(String(t || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function parseProductPage(html) {
  const title = text((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]).replace(/\s*-\s*Compare Prices[\s\S]*$/i, "") || null;
  const start = html.search(/<h2[^>]*>\s*Where To Buy\s*<\/h2>/i);
  if (start < 0) throw new Error("Trolley page layout not recognised (no Where To Buy section)");
  let end = html.indexOf("</section>", start);
  if (end < 0) end = start + 30000;
  const section = html.slice(start, end);

  const retailers = [];
  for (const chunk of section.split('<div class="_item">').slice(1)) {
    const name = decode((chunk.match(/<svg[^>]*\btitle="([^"]+)"/) || [])[1]);
    const price = text((chunk.match(/class="_price"[^>]*>\s*<b>([\s\S]*?)<\/b>/) || [])[1]);
    if (!name || !price) continue;
    retailers.push({
      name,
      price,
      promoText: text((chunk.match(/class="_product-offer"[^>]*>([\s\S]*?)<\/div>/) || [])[1]) || null,
      outboundUrl: decode((chunk.match(/href="(https:\/\/redirect\.trolley\.co\.uk\/[^"]+)"/) || [])[1]) || null,
    });
  }

  // When nobody stocks it, Trolley suggests other listings (often the same wine under another code)
  const alternatives = [];
  if (/out of stock in every store/i.test(section)) {
    for (const m of section.matchAll(/<a class="product-item" href="(\/product\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const ref = parseTrolleyRef("trolley.co.uk" + m[1]);
      const label = text((m[2].match(/class="_name"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
      const size = text((m[2].match(/class="_size"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) || [])[1]);
      if (ref && label) alternatives.push({ ...ref, name: [label, size].filter(Boolean).join(" · ") });
      if (alternatives.length >= 3) break;
    }
  }
  return { productName: title, retailers, alternatives };
}

export async function fetchProductPage(link) {
  const res = await fetch(link.url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, Accept: "text/html", "Accept-Language": "en-GB" },
  });
  if (res.status === 404) throw new Error("Trolley no longer has this product. Change the link.");
  if (!res.ok) throw new Error(`Trolley returned HTTP ${res.status}`);
  return parseProductPage(await res.text());
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

/* page retailers[] -> { Tesco: {stocked, price, offer, link}, ... } */
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

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/* Product pages -> { SKU: {matchedName, prices, alternatives} | {error} } */
export async function fetchProducts(links) {
  const bySku = {};
  await inBatches(links, FETCH_CONCURRENCY, async (link) => {
    try {
      const p = await fetchProductPage(link);
      bySku[link.sku] = { matchedName: p.productName, prices: reshape(p.retailers), alternatives: p.alternatives };
    } catch (e) {
      bySku[link.sku] = { error: e.message };
    }
  });
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
        outOfStock: !Object.keys(pe.data).length, alternatives: pe.alternatives || [],
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
      if (!p || p.error) { // temporary or link problem: not cached, tried again next check
        results[w.name] = { link: w.link, prices: {}, context: null, error: (p && p.error) || "Couldn't read this product from Trolley." };
        return;
      }
      const effective = bestEffective(p.prices);
      results[w.name] = {
        link: w.link, matchedName: p.matchedName, prices: p.prices,
        outOfStock: !Object.keys(p.prices).length, alternatives: p.alternatives || [],
        context: contextFor(effective, histories[w.i]),
      };
      const writes = [setJSON(`price:${w.key}`, { sku: w.link.sku, matchedName: p.matchedName, data: p.prices, alternatives: p.alternatives }, PRICE_TTL)];
      if (effective != null) writes.push(setJSON(`hist:${w.key}`, addToHistory(histories[w.i], effective)));
      await Promise.all(writes);
    }));
  }

  return { results, fetched: toFetch.length, cached, needLink };
}
