import { storeKind } from "../lib/store.js";

export default function handler(req, res) {
  res.status(200).json({
    status: "ok",
    apifyTokenSet: !!process.env.APIFY_TOKEN,
    storage: storeKind, // "upstash" = saved permanently; "memory" = database not connected yet
  });
}
