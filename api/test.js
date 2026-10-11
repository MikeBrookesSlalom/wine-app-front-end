import { runActor, pickBest, fetchPricesForIds } from "../lib/prices.js";

// Troubleshooting: /api/test?wine=Whispering%20Angel  (add &debug=1 to see every search candidate)
export default async function handler(req, res) {
  try {
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
    res.status(500).json({ error: e.message });
  }
}
