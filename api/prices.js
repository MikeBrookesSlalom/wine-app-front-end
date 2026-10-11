import { getPrices } from "../lib/prices.js";

// POST { wines: [{ name, trolley? }] }  trolley = Trolley product link or code
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const wines = req.body && req.body.wines;
    if (!Array.isArray(wines)) return res.status(400).json({ error: "wines must be an array" });
    if (wines.length > 100) return res.status(400).json({ error: "max 100 wines per check" });
    const out = await getPrices(wines.map((w) => (typeof w === "string" ? { name: w } : w || {})));
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
