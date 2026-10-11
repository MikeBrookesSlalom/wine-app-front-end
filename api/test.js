import { parseTrolleyRef, fetchProducts } from "../lib/prices.js";
import { parseShopLink, fetchShopPrice } from "../lib/shops.js";

// Troubleshooting:
//   /api/test?link=<Trolley product link or code>   e.g. ?link=JQK438
//   /api/test?shop=<shop product link>              e.g. a Tesco, Waitrose or Ocado product page
export default async function handler(req, res) {
  const started = Date.now();
  try {
    if (req.query.shop64) req.query.shop = Buffer.from(String(req.query.shop64), "base64url").toString("utf8");
    if (req.query.shop) {
      const link = parseShopLink(req.query.shop);
      if (link.error) return res.status(200).json({ ok: false, error: link.error });
      if (req.query.raw) { // what the shop actually sends back to this server (supported shops only)
        const r = await fetch(link.url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; CellarPriceWatch/1.0; personal weekly wine price check)", Accept: "text/html", "Accept-Language": "en-GB" }, signal: AbortSignal.timeout(Math.min(25000, Number(req.query.t) || 8000)) });
        const h = await r.text();
        return res.status(200).json({ ok: r.ok, status: r.status, bytes: h.length, finalUrl: r.url, title: (h.match(/<title>([^<]{0,120})/) || [])[1] || null,
          ldBlocks: (h.match(/application\/ld\+json/g) || []).length, server: r.headers.get("server"), ms: Date.now() - started });
      }
      const product = await fetchShopPrice(link);
      return res.status(200).json({ ok: true, link, product, ms: Date.now() - started });
    }
    const link = parseTrolleyRef(req.query.link || "JQK438");
    if (!link) return res.status(200).json({ ok: false, error: "Not a Trolley product link or code" });
    const product = (await fetchProducts([link]))[link.sku] || null;
    res.status(200).json({ ok: !!product && !product.error, link, product, ms: Date.now() - started });
  } catch (e) {
    // 200 on purpose: this is a diagnostic endpoint, so make the error readable anywhere
    res.status(200).json({ ok: false, error: e.message, ms: Date.now() - started });
  }
}
