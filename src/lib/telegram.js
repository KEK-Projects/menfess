import crypto from "node:crypto";
import { escapeHtml, truncateText, claimEventOnce } from "./infra.js";

const BOT_API_BASE = "https://api.telegram.org";
const DEFAULT_ADMIN_LOG_CHANNEL = "-1001778725181";

export async function tgCall(
  method,
  payload,
  botToken = process.env.TELEGRAM_BOT_TOKEN
) {
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const resp = await fetch(`${BOT_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  let json = null;
  try {
    json = await resp.json();
  } catch {
    throw new Error(`Telegram ${method}: invalid JSON response`);
  }

  if (!resp.ok || !json?.ok) {
    const desc = json?.description || `HTTP ${resp.status}`;
    const err = new Error(`Telegram ${method} failed: ${desc}`);
    err.tgDescription = desc;
    throw err;
  }

  return json.result;
}

export async function safeDeleteMessage(chatId, messageId) {
  if (!chatId || !messageId) return false;
  try {
    await tgCall("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
    return true;
  } catch {
    return false;
  }
}

export async function reportSystemError(
  context,
  err,
  extraMeta = "",
  deps = {}
) {
  const tgCaller = deps.tgCall || tgCall;
  const claimOnce = deps.claimEventOnce || claimEventOnce;
  const logChannelId =
    deps.logChannelId ||
    process.env.ADMIN_LOG_CHANNEL_ID ||
    DEFAULT_ADMIN_LOG_CHANNEL;

  const rawMsg =
    err instanceof Error
      ? err.stack || err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err ?? "Unknown error");

  const cleanContext = truncateText(String(context || "system"), 120);
  const cleanMsg = truncateText(String(rawMsg || "Unknown error"), 1500);
  const cleanMeta = truncateText(String(extraMeta || ""), 400);

  const hash = crypto
    .createHash("sha256")
    .update(`${cleanContext}|${cleanMsg}`)
    .digest("hex")
    .slice(0, 12);

  try {
    const canSend = await claimOnce(`errlog:mfs:${hash}`, 60).catch(
      () => true
    );
    if (!canSend) return false;

    const timeWib =
      new Date(Date.now() + 7 * 3600 * 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19) + " WIB";

    const lines = [
      `🚨 <b>[MFS]</b> <b>System Error Alert</b>`,
      `<b>Context:</b> <code>${escapeHtml(cleanContext)}</code>`,
      `<b>Time:</b> <code>${escapeHtml(timeWib)}</code>`,
    ];

    if (cleanMeta) {
      lines.push(`<b>Meta:</b> <code>${escapeHtml(cleanMeta)}</code>`);
    }

    lines.push(`<b>Error:</b>\n<pre>${escapeHtml(cleanMsg)}</pre>`);

    await tgCaller("sendMessage", {
      chat_id: logChannelId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    return true;
  } catch (logErr) {
    console.error(
      "[MFS] Failed to send error log to admin channel:",
      logErr?.message || logErr
    );
    return false;
  }
}

export async function reportAdminAudit(action, details = "", deps = {}) {
  const tgCaller = deps.tgCall || tgCall;
  const logChannelId =
    deps.logChannelId ||
    process.env.ADMIN_LOG_CHANNEL_ID ||
    DEFAULT_ADMIN_LOG_CHANNEL;

  const timeWib =
    new Date(Date.now() + 7 * 3600 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19) + " WIB";

  const lines = [
    `⭐ <b>[MFS]</b> <b>Admin VIP Audit</b>`,
    `<b>Action:</b> <code>${escapeHtml(truncateText(String(action || "vip"), 80))}</code>`,
    `<b>Time:</b> <code>${escapeHtml(timeWib)}</code>`,
  ];

  if (details) {
    lines.push(
      `<b>Detail:</b> <code>${escapeHtml(truncateText(String(details), 500))}</code>`
    );
  }

  try {
    await tgCaller("sendMessage", {
      chat_id: logChannelId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    return true;
  } catch (err) {
    console.error("[MFS] Failed to send admin audit log:", err?.message || err);
    return false;
  }
}

export function extractMediaPayload(msg) {
  if (!msg || typeof msg !== "object") return null;

  const rawCaption = typeof msg.caption === "string" ? msg.caption : "";

  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1];
    if (best && typeof best.file_id === "string" && best.file_id.length > 0) {
      return {
        mediaType: "photo",
        fileId: best.file_id,
        caption: rawCaption,
      };
    }
  }

  if (
    msg.video &&
    typeof msg.video.file_id === "string" &&
    msg.video.file_id.length > 0
  ) {
    return {
      mediaType: "video",
      fileId: msg.video.file_id,
      caption: rawCaption,
    };
  }

  if (
    msg.animation &&
    typeof msg.animation.file_id === "string" &&
    msg.animation.file_id.length > 0
  ) {
    return {
      mediaType: "animation",
      fileId: msg.animation.file_id,
      caption: rawCaption,
    };
  }

  if (
    msg.document &&
    typeof msg.document.file_id === "string" &&
    msg.document.file_id.length > 0
  ) {
    return {
      mediaType: "document",
      fileId: msg.document.file_id,
      caption: rawCaption,
    };
  }

  return null;
}

export function buildChannelHtml({
  publicCode,
  categoryLabel,
  kind,
  textBody,
  botUsername,
}) {
  const safeCode = Math.max(0, Number(publicCode) || 0);
  const safeCat = escapeHtml(categoryLabel || "Menfess");
  const cleanBot =
    typeof botUsername === "string" ? botUsername.replace(/^@/, "").trim() : "";
  const safeBot = escapeHtml(cleanBot);
  const footer = safeBot
    ? `\n\n<i>Kirim lewat @${safeBot} · Komentar di bawah</i>`
    : `\n\n<i>Komentar di bawah</i>`;

  if (kind === "text") {
    const body = escapeHtml(truncateText((textBody || "").trim(), 3500));
    return `<b>#${safeCat}</b> · <b>#${safeCode}</b>\n\n${body}${footer}`;
  }

  const trimmedCap = typeof textBody === "string" ? textBody.trim() : "";
  const capBlock =
    trimmedCap.length > 0
      ? `\n\n${escapeHtml(truncateText(trimmedCap, 850))}`
      : "";

  return `<b>#${safeCat}</b> · <b>#${safeCode}</b>${capBlock}${footer}`;
}

export async function publishToChannel({
  channelId,
  publicCode,
  categoryLabel,
  kind,
  mediaType,
  fileId,
  textBody,
  botUsername,
}) {
  const html = buildChannelHtml({
    publicCode,
    categoryLabel,
    kind,
    textBody,
    botUsername,
  });

  if (kind === "text") {
    return tgCall("sendMessage", {
      chat_id: channelId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  const methodMap = {
    photo: ["sendPhoto", "photo"],
    video: ["sendVideo", "video"],
    animation: ["sendAnimation", "animation"],
    document: ["sendDocument", "document"],
  };

  const [method, field] = methodMap[mediaType] || ["sendDocument", "document"];

  return tgCall(method, {
    chat_id: channelId,
    [field]: fileId,
    caption: html,
    parse_mode: "HTML",
  });
}
