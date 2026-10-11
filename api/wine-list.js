import { getWineList } from "../lib/winelist.js";

export default async function handler(req, res) {
  try {
    res.status(200).json(await getWineList({ debug: req.query.debug === "1" }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
