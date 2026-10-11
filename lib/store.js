/* Tiny key-value store.
   Uses Upstash Redis over its REST API when the Vercel ↔ Upstash integration
   has injected credentials; otherwise falls back to process memory (works,
   but forgets everything between cold starts — fine for testing only). */

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const PREFIX = "cpw:";

const memory = new Map(); // key -> { value, expiresAt }

export const storeKind = URL_ && TOKEN ? "upstash" : "memory";

async function redis(command) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Redis ${res.status}: ${body.error || "request failed"}`);
  return body.result;
}

export async function getJSON(key) {
  const k = PREFIX + key;
  if (storeKind === "memory") {
    const hit = memory.get(k);
    if (!hit) return null;
    if (hit.expiresAt && hit.expiresAt < Date.now()) { memory.delete(k); return null; }
    return hit.value;
  }
  const raw = await redis(["GET", k]);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function getManyJSON(keys) {
  if (!keys.length) return [];
  if (storeKind === "memory") return Promise.all(keys.map(getJSON));
  const raws = await redis(["MGET", ...keys.map((k) => PREFIX + k)]);
  return (raws || []).map((raw) => {
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  });
}

export async function setJSON(key, value, ttlSeconds) {
  const k = PREFIX + key;
  if (storeKind === "memory") {
    memory.set(k, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    return;
  }
  const cmd = ["SET", k, JSON.stringify(value)];
  if (ttlSeconds) cmd.push("EX", String(ttlSeconds));
  await redis(cmd);
}
