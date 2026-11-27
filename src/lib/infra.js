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

function wibDateStr(offsetMs = 0) {
  return new Date(Date.now() + 7 * 3600 * 1000 + offsetMs)
    .toISOString()
    .slice(0, 10);
}

function quotaKeyForTodayWib(userId) {
  return `q:${userId}:${wibDateStr(0)}`;
}

// 1. Deduplication event via SET NX EX (1 perintah Redis)
export async function claimEventOnce(eventKey, ttlSec = 120) {
  
