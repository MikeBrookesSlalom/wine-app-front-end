import { gunzipSync } from "node:zlib";
import { getJSON, setJSON } from "./store.js";
import { majesticNameFromUrl } from "./majestic.js";

/* Majestic prices from Majestic's official product feed on Awin (affiliate network).
   Set AWIN_MAJESTIC_FEED_URL to the download link from Awin's "Create-a-Feed" (CSV, gzip
   or plain). The whole Majestic catalogue is downloaded at most once a day, stored as a
   compact list, and each wine is matched by its Majestic link (if pasted) or by name.
   The app's links go straight to majestic.co.uk, not through affiliate tracking. */

const DAY_MS = 24 * 60 * 60 * 1000;
const feedUrl = () => (process.env.AWIN_MAJESTIC_FEED_URL || "").trim();
export const majesticFeedEnabled = () => !!feedUrl();

/* ---------- CSV (RFC 4180: quotes, escaped quotes, newlines inside quotes) ---------- */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, q = false;
  const delim = (text.slice(0, 2000).split("\n")[0].match(/\|/g) || []).length > (text.slice(0, 2000).split("\n")[0].match(/,/g) || []).length ? "|" : ",";
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === delim) { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^\d.]/g, "")); return n > 0 ? n : null; };

/* Feed rows -> compact catalogue of Majestic products */
export function catalogueFromCsv(text) {
  const rows = parseCsv(text);
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const col = (...names) => names.map((n) => head.indexOf(n)).find((ix) => ix >= 0) ?? -1;
  const ix = {
    name: col("product_name", "title"),
    price: col("search_price", "store_price", "display_price", "price"),
    rrp: col("rrp_price", "base_price", "product_price_old"),
    url: col("merchant_deep_link", "link"),
    id: col("merchant_product_id", "aw_product_id", "id"),
    merchant: col("merchant_name"),
    inStock: col("in_stock", "is_for_sale", "availability", "stock_status"),
  };
  if (ix.name < 0 || ix.price < 0) throw new Error("Majestic feed is missing product_name or search_price columns");
  const items = [];
  for (const r of rows) {
    if (!r || r.length < head.length - 2) continue;
    if (ix.merchant >= 0 && r[ix.merchant] && !/majestic/i.test(r[ix.merchant])) continue;
    const price = num(r[ix.price]);
    if (!price) continue;
    const stock = ix.inStock >= 0 ? String(r[ix.inStock]).trim().toLowerCase() : "1";
    items.push({
      name: r[ix.name].trim(),
      price,
      was: ix.rrp >= 0 ? num(r[ix.rrp]) : null,
      url: ix.url >= 0 ? r[ix.url].trim() : "",
      id: ix.id >= 0 ? String(r[ix.id]).trim() : "",
      inStock: !/^(0|no|false|out of stock|out_of_stock)$/.test(stock),
    });
  }
  return items;
}

// Wines checked together share one download (and one read of the stored copy).
let inFlight = null, inFlightAt = 0;
function loadCatalogue() {
  if (!inFlight || Date.now() - inFlightAt > 60 * 1000) {
    inFlightAt = Date.now();
    inFlight = loadCatalogueOnce().catch((e) => { inFlight = null; throw e; });
  }
  return inFlight;
}

async function loadCatalogueOnce() {
  const cached = await getJSON("majfeed").catch(() => null);
  if (cached && Date.now() - cached.at < DAY_MS) return cached.items;
  try {
    const res = await fetch(feedUrl(), { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Awin feed returned HTTP ${res.status}`);
    let buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
    const items = catalogueFromCsv(buf.toString("utf8"));
    if (!items.length) throw new Error("Majestic feed had no products");
    await setJSON("majfeed", { at: Date.now(), items }).catch(() => {});
    return items;
  } catch (e) {
    if (cached) return cached.items; // keep using yesterday's prices rather than none
    throw e;
  }
}

/* ---------- matching ---------- */
const plain = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const STOP = new Set(["the", "de", "du", "la", "le", "les", "del", "di", "da", "and", "et", "y", "of", "wine", "wines", "75cl", "750ml", "majestic"]);
const terms = (t) => plain(t).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^(19|20)\d\d$/.test(w));
const VARIANT = /\b(magnum|jeroboam|half bottle|37\.?5\s?cl|150\s?cl|1\.5\s?l|case of|x\s?6|6\s?x|mixed|gift|personalised|bag in box|\d+\s?bottles?)\b/i;
const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, "").toLowerCase(); } catch { return ""; } };

export function matchMajestic(items, wineName, majesticUrl) {
  if (majesticUrl) {
    const p = pathOf(majesticUrl);
    const byUrl = p && items.find((it) => pathOf(it.url) === p);
    if (byUrl) return byUrl;
    const code = (p.match(/-(\d{3,})$/) || [])[1];
    const byCode = code && items.find((it) => it.id === code || it.id.endsWith(code) || pathOf(it.url).endsWith(`-${code}`));
    if (byCode) return byCode;
  }
  const name = majesticNameFromUrl(majesticUrl) || wineName;
  const want = terms(name);
  if (!want.length) return null;
  let best = null, bestScore = -Infinity;
  for (const it of items) {
    const title = plain(it.name);
    if (!want.every((w) => title.includes(w))) continue;
    if (VARIANT.test(title) && !VARIANT.test(plain(name))) continue;
    const score = -Math.abs(terms(it.name).length - want.length) + (it.inStock ? 0.5 : 0);
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best;
}

/* -> { price, offer, title, link, inStock } | null */
export async function majesticFeedPrice(wineName, majesticUrl) {
  if (!majesticFeedEnabled()) return null;
  const hit = matchMajestic(await loadCatalogue(), wineName, majesticUrl);
  if (!hit) return null;
  return {
    price: hit.price,
    offer: hit.was && hit.was > hit.price ? `Was £${hit.was.toFixed(2)}` : null,
    title: hit.name,
    link: majesticUrl || hit.url || `https://www.majestic.co.uk/search?q=${encodeURIComponent(wineName)}`,
    inStock: hit.inStock,
  };
}
