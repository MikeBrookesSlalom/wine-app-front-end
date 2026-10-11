/* Tiny key-value store for the price cache, product matches and price history.
   Uses, in order of preference:
     1. Vercel Blob (private store connected to the project)
     2. Upstash Redis (if that Vercel integration is connected instead)
     3. Process memory — works, but forgets everything between cold starts. */
import { createHash } from "node:crypto";

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const HAS_BLOB = !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
const PREFIX = "cpw:";

export const storeKind = HAS_BLOB ? "blob" : REDIS_URL && REDIS_TOKEN ? "upstash" : "memory";

/* ---------- memory ---------- */
const memory = new Map(); // key -> { value, expiresAt }

/* ---------- Vercel Blob ---------- */
let blobSdk = null;
const sdk = async () => (blobSdk ||= await import("@vercel/blob"));
// One small private JSON file per key; the name is a hash so any wine name is safe.
const blobPath = (key) => `cpw/${createHash("sha1").update(key).digest("hex")}.json`;

async function blobGet(key) {
  const { get } = await sdk();
  const res = await get(blobPath(key), { access: "private", useCache: false }).catch((e) => {
    if (/not.?found/i.test(e?.name || "") || /not.?found/i.test(e?.message || "")) return null;
    throw e;
  });
  if (!res || res.statusCode !== 200 || !res.stream) return null;
  const doc = JSON.parse(await new Response(res.stream).text());
  if (doc.expiresAt && doc.expiresAt < Date.now()) return null;
  return doc.value ?? null;
}

async function blobSet(key, value, ttlSeconds) {
  const { put } = await sdk();
  const doc = { key, value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null };
  await put(blobPath(key), JSON.stringify(doc), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
}

/* ---------- Upstash Redis (REST) ---------- */
async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Redis ${res.status}: ${body.error || "request failed"}`);
  return body.result;
}
const parse = (raw) => { if (raw == null) return null; try { return JSON.parse(raw); } catch { return null; } };

/* ---------- public API ---------- */
export async function getJSON(key) {
  const k = PREFIX + key;
  if (storeKind === "blob") return blobGet(k);
  if (storeKind === "upstash") return parse(await redis(["GET", k]));
  const hit = memory.get(k);
  if (!hit) return null;
  if (hit.expiresAt && hit.expiresAt < Date.now()) { memory.delete(k); return null; }
  return hit.value;
}

export async function getManyJSON(keys) {
  if (!keys.length) return [];
  if (storeKind === "upstash") return ((await redis(["MGET", ...keys.map((k) => PREFIX + k)])) || []).map(parse);
  return Promise.all(keys.map(getJSON));
}

export async function setJSON(key, value, ttlSeconds) {
  const k = PREFIX + key;
  if (storeKind === "blob") return blobSet(k, value, ttlSeconds);
  if (storeKind === "upstash") {
    const cmd = ["SET", k, JSON.stringify(value)];
    if (ttlSeconds) cmd.push("EX", String(ttlSeconds));
    await redis(cmd);
    return;
  }
  memory.set(k, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
}
