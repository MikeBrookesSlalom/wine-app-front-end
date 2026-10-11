import { getJSON, setJSON } from "./store.js";

/* Direct shop links: one product page per wine per shop, read the same way a browser
   would, respecting each site's robots.txt. Every shop below was checked to serve its
   price in the page (or, for Sainsbury's, the JSON its own product page loads). */

const USER_AGENT = "Mozilla/5.0 (compatible; CellarPriceWatch/1.0; personal weekly wine price check)";
const ROBOTS_TTL = 7 * 24 * 60 * 60;

const decode = (t) => String(t || "")
  .replace(/&pound;/g, "£").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;|&rsquo;/g, "'")
  .replace(/&quot;/g, '"').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const toNum = (v) => (typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.]/g, "")));
const money = (n) => `£${Number(n).toFixed(2)}`;

/* ---------- shops ---------- */
// Sites that block automated requests outright (bot walls), so no server can read them.
const BLOCKED = [
  [/(^|\.)majestic\.co\.uk$/, "Majestic"],
  [/(^|\.)coop\.co\.uk$/, "Co-op"],
  [/(^|\.)thewhiskyexchange\.com$/, "The Whisky Exchange"],
  [/(^|\.)sainsburys\.co\.uk$/, "Sainsbury's"], // refuses requests from cloud servers (HTTP 403)
  [/(^|\.)waitrose\.com$/, "Waitrose"],          // never answers cloud servers (times out); Waitrose Cellar works
];
// Sites whose pages only fill in the price inside the browser.
const BROWSER_ONLY = [
  [/(^|\.)aldi\.co\.uk$/, "Aldi"],
  [/(^|\.)marksandspencer\.com$/, "M&S"],
];

export const SHOPS = [
  { key: "tesco", label: "Tesco", host: /(^|\.)tesco\.com$/,
    id: (u) => (u.pathname.match(/\/products\/(\d+)/) || [])[1],
    url: (id) => `https://www.tesco.com/groceries/en-GB/products/${id}` },
  { key: "asda", label: "ASDA", host: /(^|\.)asda\.com$/,
    id: (u) => (u.pathname.match(/\/product\/(?:[^/]+\/)*(\d{4,})\/?$/) || [])[1],
    url: (id, u) => `https://www.asda.com${u.pathname}` },
  { key: "waitrosecellar", label: "Waitrose Cellar", host: /(^|\.)waitrosecellar\.com$/,
    id: (u) => (u.pathname.match(/-(\d+)\/?$/) || u.pathname.match(/\/(\d+)\/?$/) || [])[1],
    url: (id, u) => `https://www.waitrosecellar.com${u.pathname}` },
  { key: "ocado", label: "Ocado", host: /(^|\.)ocado\.com$/,
    id: (u) => (u.pathname.match(/\/products\/(?:[^/]*?[/-])?(\d{5,})\/?$/) || [])[1],
    url: (id, u) => `https://www.ocado.com${u.pathname}` },
  { key: "morrisons", label: "Morrisons", host: /(^|\.)morrisons\.com$/,
    id: (u) => (u.pathname.match(/\/products\/(?:[^/]*?[/-])?(\d{5,})\/?$/) || [])[1],
    url: (id, u) => `https://groceries.morrisons.com${u.pathname}` },
  { key: "costco", label: "Costco", host: /(^|\.)costco\.co\.uk$/,
    id: (u) => (u.pathname.match(/\/p\/(\d+)/) || [])[1],
    url: (id, u) => `https://www.costco.co.uk${u.pathname}` },
];
export const SUPPORTED_SHOP_NAMES = SHOPS.map((s) => s.label);

/* Paste -> { shop, label, id, url } or { error } */
export function parseShopLink(input) {
  const m = String(input || "").match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return { error: "That doesn't look like a web link." };
  let u;
  try { u = new URL(m[0]); } catch { return { error: "That doesn't look like a web link." }; }
  const host = u.hostname.toLowerCase();
  for (const [re, name] of BLOCKED) if (re.test(host)) return { error: `${name} blocks automatic price checks, so it can't be tracked.${name === "Waitrose" ? " For wine, use the same bottle on Waitrose Cellar (waitrosecellar.com) instead." : ""}` };
  for (const [re, name] of BROWSER_ONLY) if (re.test(host)) return { error: `${name} only shows prices inside a browser, so it can't be checked automatically.` };
  if (/(^|\.)trolley\.co\.uk$/.test(host)) return { error: "That's a Trolley link: use it in the Trolley box instead." };
  const shop = SHOPS.find((s) => s.host.test(host));
  if (!shop) return { error: `Not a supported shop yet. Supported: ${SUPPORTED_SHOP_NAMES.join(", ")}.` };
  const id = shop.id(u);
  if (!id) return { error: `That ${shop.label} link isn't a product page. Open the wine itself and copy its link.` };
  return { shop: shop.key, label: shop.label, id, url: shop.url(id, u) };
}

/* ---------- robots.txt ---------- */
function robotsAllows(txt, path) {
  // Rules for "User-agent: *" (and our own name, if a site ever lists it); longest match wins.
  const rules = [];
  let applies = false, inAgents = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase(), val = m[2].trim();
    if (field === "user-agent") {
      if (!inAgents) applies = false;
      inAgents = true;
      if (val === "*" || /cellarpricewatch/i.test(val)) applies = true;
      continue;
    }
    inAgents = false;
    if (applies && (field === "allow" || field === "disallow") && val) rules.push({ allow: field === "allow", val });
  }
  let best = null;
  for (const r of rules) {
    const re = new RegExp("^" + r.val.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(path) && (!best || r.val.length > best.val.length || (r.val.length === best.val.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

async function allowedByRobots(url) {
  const u = new URL(url);
  const key = `robots:${u.hostname}`;
  let entry = await getJSON(key).catch(() => null);
  if (!entry) {
    try {
      const res = await fetch(`${u.origin}/robots.txt`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
      entry = { txt: res.ok ? (await res.text()).slice(0, 200000) : "" };
    } catch { entry = { txt: "" }; } // unreachable robots.txt: treat as no rules
    await setJSON(key, entry, ROBOTS_TTL).catch(() => {});
  }
  return robotsAllows(entry.txt, u.pathname + u.search);
}
export { robotsAllows };

/* ---------- reading prices ---------- */
function jsonLdProduct(html) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x !== "object") continue;
      if (Array.isArray(x)) { stack.push(...x); continue; }
      const t = [].concat(x["@type"] || []).join(" ");
      if (/\bProduct\b/.test(t) && x.offers) return x;
      if (x["@graph"]) stack.push(x["@graph"]);
    }
  }
  return null;
}
// When a page's structured data isn't valid JSON, fall back to the price meta tags or the raw text of the Product block.
function looseProduct(html) {
  const meta = html.match(/<meta[^>]+(?:property|name|itemprop)="(?:product:price:amount|og:price:amount|price)"[^>]*content="([\d.]+)"/i)
    || html.match(/<meta[^>]+content="([\d.]+)"[^>]*(?:property|name|itemprop)="(?:product:price:amount|og:price:amount|price)"/i);
  const block = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).find((t) => /"@type"\s*:\s*"Product"/.test(t));
  const ldPrice = block && (block.match(/"price"\s*:\s*"?([\d.]+)/) || [])[1];
  const price = toNum(ldPrice || (meta && meta[1]));
  if (!(price > 0)) return null;
  const name = block && (block.match(/"name"\s*:\s*"([^"]{2,150})"/) || [])[1];
  const avail = block && (block.match(/"availability"\s*:\s*"([^"]+)"/) || [])[1];
  return { name: name || null, offers: { price, availability: avail || "InStock" } };
}

function offerFrom(product) {
  const offers = [].concat(product.offers || []).flatMap((o) => (o && o["@type"] === "AggregateOffer" ? [].concat(o.offers || { price: o.lowPrice, availability: o.availability }) : [o]));
  const o = offers.find((x) => x && !isNaN(toNum(x.price)) && toNum(x.price) > 0);
  if (!o) return null;
  return { price: toNum(o.price), inStock: !/OutOfStock|SoldOut|Discontinued/i.test(String(o.availability || "")) };
}
// An offer line that belongs to this product: its id must appear shortly before it in the page data.
function promoNear(html, id, re) {
  const idAt = [...html.matchAll(new RegExp(String(id), "g"))].map((m) => m.index);
  for (const m of html.matchAll(re)) {
    const before = idAt.filter((i) => i < m.index).pop();
    if (before != null && m.index - before < 1500) return decode(m[1]).trim();
  }
  return null;
}

export function parseShopPage(shopKey, html, id) {
  if (shopKey === "sainsburys") {
    const j = JSON.parse(html);
    const p = (j.products || [])[0];
    if (!p) throw new Error("Sainsbury's didn't return this product");
    const price = toNum(p.retail_price && p.retail_price.price);
    const promos = (p.promotions || []).map((x) => x.strap_line).filter(Boolean);
    const nectar = p.nectar_price && toNum(p.nectar_price.retail_price ?? p.nectar_price.price);
    const offer = nectar > 0 && nectar < price ? `${money(nectar)} with Nectar` : promos[0] || null;
    return { name: p.name || null, price, inStock: p.is_available !== false, offer };
  }
  const product = jsonLdProduct(html) || looseProduct(html);
  const o = product && offerFrom(product);
  if (!o) throw new Error("Couldn't find a price on that page");
  let offer = null;
  if (shopKey === "tesco") {
    // While a Clubcard Price runs, the structured price can be the Clubcard one; the page
    // summary states both ("Regular price £8.5, Clubcard price is £7"), so use that.
    const reg = html.match(/Regular price £\s?([\d.]+)/i);
    const cc = html.match(/Clubcard price is £\s?([\d.]+)/i);
    if (reg && toNum(reg[1]) > 0) o.price = toNum(reg[1]);
    if (cc && toNum(cc[1]) < o.price) offer = `${money(toNum(cc[1]))} Clubcard Price`;
  } else if (shopKey === "ocado" || shopKey === "morrisons") {
    offer = promoNear(html, id, /"description":"([^"]{3,90})","type":"OFFER"/g)
      || promoNear(html, id, /"promotions":\[\{[^\]]{0,200}?"description":"([^"]{3,90})"/g);
  } else if (shopKey === "waitrose") {
    offer = promoNear(html, id, /"promotionDescription":"([^"]{3,90})"/g);
  }
  return { name: decode(product.name || "") || null, price: o.price, inStock: o.inStock, offer };
}

function fetchUrlFor(link) {
  if (link.shop === "sainsburys") {
    const seo = encodeURIComponent(`gb/groceries/${link.id}`);
    return { url: `https://www.sainsburys.co.uk/groceries-api/gol-services/product/v1/product?filter%5Bproduct_seo_url%5D=${seo}&include%5BASSOCIATIONS%5D=false`, accept: "application/json" };
  }
  return { url: link.url, accept: "text/html" };
}

export async function fetchShopPrice(link) {
  const { url, accept } = fetchUrlFor(link);
  if (!(await allowedByRobots(url))) throw new Error(`${link.label}'s robots.txt doesn't allow automatic checks of this page`);
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "en-GB" },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) throw new Error(`${link.label} no longer has this product`);
  if (res.status === 403 || res.status === 429) throw new Error(`${link.label} refused the request (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`${link.label} returned HTTP ${res.status}`);
  return parseShopPage(link.shop, await res.text(), link.id);
}
