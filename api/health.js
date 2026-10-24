import { storeKind } from "../lib/store.js";

export default function handler(req, res) {
  res.status(200).json({
    status: "ok",
    priceSource: "trolley.co.uk product pages (direct)",
    majestic: (process.env.AWIN_MAJESTIC_FEED_URL || "").trim() ? "awin feed" : (process.env.MAJESTIC_VIA_SHOPPING === "1" && (process.env.SERPAPI_KEY || "").trim()) ? "google shopping" : "off",
    storage: storeKind, // "blob" or "upstash" = saved permanently; "memory" = no storage connected
  });
}
