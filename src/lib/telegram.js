import { escapeHtml, truncateText } from "./infra.js";

const BOT_API_BASE = "https://api.telegram.org";

export async function tgCall(method, payload, botToken = process.env.TELEGRAM_BOT_TOKEN) {
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

  if (msg.video && typeof msg.video.file_id === "string" && msg.video.file_id.length > 0) {
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
  const cleanBot = typeof botUsername === "string" ? botUsername.replace(/^@/, "").trim() : "";
  const safeBot = escapeHtml(cleanBot);
  const footer = safeBot
    ? `\n\n<i>Kirim lewat @${safeBot} · Komentar di bawah</i>`
    : `\n\n<i>Komentar di bawah</i>`;

  if (kind === "text") {
    const body = escapeHtml(truncateText((textBody || "").trim(), 3500));
    return `<b>#${safeCat}</b> · <b>#${safeCode}</b>\n\n${body}${footer}`;
  }

  // Media: caption opsional (boleh kosong)
  const trimmedCap = typeof textBody === "string" ? textBody.trim() : "";
  const capBlock =
    trimmedCap.length > 0 ? `\n\n${escapeHtml(truncateText(trimmedCap, 850))}` : "";

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
