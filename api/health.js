import { storeKind } from "../lib/store.js";

export default function handler(req, res) {
  res.status(200).json({
    status: "ok",
    priceSource: "trolley.co.uk product pages (direct)",
    majestic: !!(process.env.SERPAPI_KEY || "").trim(), // Majestic prices via Google Shopping need SERPAPI_KEY
    storage: storeKind, // "blob" or "upstash" = saved permanently; "memory" = no storage connected
  });
}
