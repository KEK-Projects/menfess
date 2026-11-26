import { Redis } from "@upstash/redis";
import { createClient } from "@supabase/supabase-js";

export const redis = Redis.fromEnv();

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

const DEFAULT_CATEGORIES = [
  { slug: "curhat", label: "Curhat" },
  { slug: "saran", label: "Saran" },
  { slug: "random", label: "Random" },
];

export function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function truncateText(str, maxLen) {
  if (typeof str !== "string" || maxLen <= 0) return "";
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

function quotaKeyForTodayWib(userId) {
  const wibDate = new Date(Date.now() + 7 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  return `q:${userId}:${wibDate}`;
}

// 1. Deduplication event via SET NX EX (1 perintah Redis)
export async function claimEventOnce(eventKey, ttlSec = 120) {
  const res = await redis.set(`dedup:${eventKey}`, "1", {
    nx: true,
    ex: ttlSec,
  });
  return res === "OK";
}

// 2. Lua Script atomik cek + inkremen kuota harian (1 panggilan Redis)
const QUOTA_CONSUME_LUA = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local ttl = tonumber(ARGV[2])

  local used = tonumber(redis.call("GET", key) or "0")
  if used >= limit then
    return { 0, used }
  end

  local next_used = redis.call("INCR", key)
  if next_used == 1 then
    redis.call("EXPIRE", key, ttl)
  end
  return { 1, next_used }
`;

// Lua Script atomik refund kuota jika nilai > 0 (1 panggilan Redis)
const QUOTA_REFUND_LUA = `
  local key = KEYS[1]
  local cur = tonumber(redis.call("GET", key) or "0")
  if cur > 0 then
    return redis.call("DECR", key)
  end
  return 0
`;

export async function consumeDailyQuota(userId, dailyLimit = 5) {
  const safeLimit = Math.max(1, Number(dailyLimit) || 5);
  const key = quotaKeyForTodayWib(userId);
  const [ok, used] = await redis.eval(QUOTA_CONSUME_LUA, [key], [safeLimit, 90000]);
  return {
    allowed: Number(ok) === 1,
    used: Number(used) || 0,
    limit: safeLimit,
  };
}

export async function refundDailyQuota(userId) {
  const key = quotaKeyForTodayWib(userId);
  await redis.eval(QUOTA_REFUND_LUA, [key], []);
}

// 3. Cache kategori aktif di Redis (TTL 3600s) -> fallback Supabase saat cache miss
export async function getActiveCategories() {
  const cacheKey = "cfg:cats:v1";
  const cached = await redis.get(cacheKey);
  if (Array.isArray(cached) && cached.length > 0) {
    return cached;
  }

  const { data, error } = await supabase
    .from("categories")
    .select("slug,label")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .limit(12);

  const list =
    !error && Array.isArray(data) && data.length > 0
      ? data
      : DEFAULT_CATEGORIES;

  await redis.set(cacheKey, list, { ex: 3600 });
  return list;
}

// 4. Session state ringkas di Redis (1 key per user, TTL 900s)
export async function getSession(userId) {
  const raw = await redis.get(`sess:${userId}`);
  return raw && typeof raw === "object" ? raw : null;
}

export async function setSession(userId, sessObj) {
  await redis.set(`sess:${userId}`, sessObj, { ex: 900 });
}

export async function clearSession(userId) {
  await redis.del(`sess:${userId}`);
}
