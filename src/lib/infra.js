import { Redis } from "@upstash/redis";
import { createClient } from "@supabase/supabase-js";
import { reportSystemError } from "./telegram.js";

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

function wibDateStr(offsetMs = 0) {
  return new Date(Date.now() + 7 * 3600 * 1000 + offsetMs)
    .toISOString()
    .slice(0, 10);
}

function quotaKeyForTodayWib(userId) {
  return `q:${userId}:${wibDateStr(0)}`;
}

export async function claimEventOnce(eventKey, ttlSec = 120) {
  const res = await redis.set(`dedup:${eventKey}`, "1", {
    nx: true,
    ex: ttlSec,
  });
  return res === "OK";
}

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
  const [ok, used] = await redis.eval(
    QUOTA_CONSUME_LUA,
    [key],
    [safeLimit, 90000]
  );

  if (Math.random() < 0.1) {
    const yesterdayKey = `q:${userId}:${wibDateStr(-86400 * 1000)}`;
    redis.del(yesterdayKey).catch(() => null);
  }

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

export async function runPeriodicDbSelfHeal(
  keepDays = 30,
  statuses = ["published", "rejected"],
  lockSeconds = 3600,
  deps = {}
) {
  const redisClient = deps.redis || redis;
  const supabaseClient = deps.supabase || supabase;
  const notifyError = deps.reportError || reportSystemError;

  try {
    const safeLockSec = Math.min(
      604800,
      Math.max(60, Number(lockSeconds) || 3600)
    );
    const lockOk = await redisClient.set("heal:db:lock", "1", {
      nx: true,
      ex: safeLockSec,
    });
    if (lockOk !== "OK") return false;

    const normalizedStatuses =
      Array.isArray(statuses) && statuses.length > 0
        ? statuses.map((s) => String(s).trim()).filter(Boolean)
        : null;

    const safeKeepDays = Math.max(1, Number(keepDays) || 30);

    const { data, error } = await supabaseClient.rpc(
      "purge_old_menfess_posts",
      {
        p_keep_days: safeKeepDays,
        p_statuses: normalizedStatuses,
      }
    );

    if (error) {
      console.error("[MFS] DB self-heal error:", error.message);
      await notifyError(
        "db_self_heal_rpc",
        error.message,
        `keepDays=${safeKeepDays} statuses=${normalizedStatuses ? normalizedStatuses.join(",") : "ALL"}`
      ).catch(() => null);
      return false;
    }

    const deletedCount = Number(data ?? 0);
    console.log(
      `[MFS][DB Self-Heal] purged=${deletedCount} rows (keepDays=${safeKeepDays}, statuses=${normalizedStatuses ? normalizedStatuses.join(",") : "ALL"})`
    );

    return true;
  } catch (err) {
    console.error("[MFS] DB self-heal exception:", err?.message || err);
    await notifyError("db_self_heal_exception", err).catch(() => null);
    return false;
  }
}

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

  if (error) {
    await reportSystemError("get_active_categories", error.message).catch(
      () => null
    );
  }

  const list =
    !error && Array.isArray(data) && data.length > 0
      ? data
      : DEFAULT_CATEGORIES;

  await redis.set(cacheKey, list, { ex: 3600 });
  return list;
}

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
