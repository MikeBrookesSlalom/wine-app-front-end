import { runActor, pickBest, fetchPricesForIds } from "../lib/prices.js";

// Troubleshooting: /api/test?wine=Whispering%20Angel  (add &debug=1 to see every search candidate)
export default async function handler(req, res) {
  const started = Date.now();
  try {
    // Raw probe of the studio-amba scraper for one Trolley product URL: /api/test?amba=<url>
    if (req.query.amba) {
      const token = (process.env.APIFY_TOKEN || "").trim();
      const r = await fetch(`https://api.apify.com/v2/acts/studio-amba~trolley-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productUrls: [String(req.query.amba)], maxResults: 1 }),
      });
      const text = await r.text();
      return res.status(200).json({ ok: r.ok, status: r.status, ms: Date.now() - started, body: text.slice(0, 6000) });
    }
    const wine = String(req.query.wine || "Whispering Angel");
    const items = await runActor({ mode: "search", searchQuery: wine, sortOrder: "relevance", maxItems: 12 });
    const best = pickBest(items, wine);
    if (req.query.debug === "1") {
      const candidates = items.map((it) => ({ productId: it.productId, name: it.name, brand: it.brand, size: it.size, price: it.price }));
      return res.status(200).json({ wine, matched: best?.name || null, productId: best?.productId || null, candidates });
    }
    if (!best) return res.status(200).json({ wine, matched: null, prices: {} });
    const entry = (await fetchPricesForIds([best.productId]))[best.productId] || { prices: {} };
    res.status(200).json({ wine, matched: best.name, productId: best.productId, prices: entry.prices });
  } catch (e) {
    // 200 on purpose: this is a diagnostic endpoint, so make the error readable anywhere
    res.status(200).json({ ok: false, error: e.message, ms: Date.now() - started });
  }
}
