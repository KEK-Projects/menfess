import {
  claimEventOnce,
  consumeDailyQuota,
  refundDailyQuota,
  getActiveCategories,
  getSession,
  setSession,
  clearSession,
  supabase,
  escapeHtml,
  truncateText,
} from "../src/lib/infra.js";
import { isValidTelegramSecret } from "../src/lib/security.js";
import {
  tgCall,
  extractMediaPayload,
  publishToChannel,
} from "../src/lib/telegram.js";

const CHANNEL_ID = process.env.MENFESS_CHANNEL_ID;
const BOT_USERNAME = process.env.BOT_USERNAME || "";
const DAILY_QUOTA = Number(process.env.DAILY_QUOTA || 3);
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

function mainMenuMarkup() {
  return {
    inline_keyboard: [
      [{ text: "✉️ Kirim Menfess", callback_data: "mf:open" }],
    ],
  };
}

function kindChoiceMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "📝 Menfess Teks", callback_data: "mf:kind:text" },
        { text: "🖼 Menfess Media", callback_data: "mf:kind:media" },
      ],
      [{ text: "❌ Batal", callback_data: "mf:cancel" }],
    ],
  };
}

function categoryMarkup(categories) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const row = categories.slice(i, i + 2).map((c) => ({
      text: c.label,
      callback_data: `mf:cat:${c.slug}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: "❌ Batal", callback_data: "mf:cancel" }]);
  return { inline_keyboard: rows };
}

async function handleCallback(cq) {
  const cqId = cq.id;
  const userId = cq.from?.id;
  const chatId = cq.message?.chat?.id;
  const msgId = cq.message?.message_id;
  const data = typeof cq.data === "string" ? cq.data : "";

  if (!userId || !chatId || !cqId) return;

  const [isUnique] = await Promise.all([
    claimEventOnce(`cq:${cqId}`, 120),
    tgCall("answerCallbackQuery", { callback_query_id: cqId }).catch(() => null),
  ]);

  if (!isUnique) return;

  if (data === "mf:cancel") {
    await Promise.all([
      clearSession(userId),
      msgId
        ? tgCall("editMessageText", {
            chat_id: chatId,
            message_id: msgId,
            text: "Pengiriman menfess dibatalkan.",
            parse_mode: "HTML",
            reply_markup: mainMenuMarkup(),
          }).catch(() => null)
        : Promise.resolve(),
    ]);
    return;
  }

  if (data === "mf:open") {
    await setSession(userId, { s: "PICK_KIND" });
    const text =
      "<b>Pilih Jenis Menfess</b>\n\n" +
      "• <b>Menfess Teks</b>: wajib isi teks.\n" +
      "• <b>Menfess Media</b>: foto/video/dokumen/GIF, teks/caption boleh kosong.";

    if (msgId) {
      await tgCall("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text,
        parse_mode: "HTML",
        reply_markup: kindChoiceMarkup(),
      });
    }
    return;
  }

  if (data === "mf:kind:text" || data === "mf:kind:media") {
    const kind = data === "mf:kind:text" ? "text" : "media";
    await setSession(userId, { s: "WAIT_INPUT", k: kind });

    const promptHtml =
      kind === "text"
        ? "<b>Mode: Menfess Teks</b>\n\nSilakan kirimkan isi pesan teks Anda (maksimal 3500 karakter). Teks tidak boleh kosong."
        : "<b>Mode: Menfess Media</b>\n\nSilakan kirimkan foto, video, GIF, atau dokumen. Caption/teks bersifat <b>opsional</b> (boleh dikosongkan).";

    if (msgId) {
      await tgCall("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: promptHtml,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "❌ Batal", callback_data: "mf:cancel" }]],
        },
      });
    }
    return;
  }

  if (data.startsWith("mf:cat:")) {
    const slug = data.slice(7);
    const [sess, categories] = await Promise.all([
      getSession(userId),
      getActiveCategories(),
    ]);

    const chosenCat = categories.find((c) => c.slug === slug);
    if (!sess || sess.s !== "PICK_CAT" || !chosenCat || !sess.m) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Sesi sudah berakhir atau tidak valid. Mulai lagi dengan /start.",
        parse_mode: "HTML",
      });
      return;
    }

    if (sess.k === "text" && (!sess.m.t || !sess.m.t.trim())) {
      await setSession(userId, { s: "WAIT_INPUT", k: "text" });
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Menfess teks tidak boleh kosong. Silakan kirim teks Anda.",
        parse_mode: "HTML",
      });
      return;
    }

    const quota = await consumeDailyQuota(userId, DAILY_QUOTA);
    if (!quota.allowed) {
      await clearSession(userId);
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: `Kuota menfess harian Anda sudah habis (<b>${quota.used}/${quota.limit}</b>). Silakan coba lagi besok.`,
        parse_mode: "HTML",
        reply_markup: mainMenuMarkup(),
      });
      return;
    }

    try {
      const { data: rpcRows, error: rpcErr } = await supabase.rpc(
        "create_menfess_post",
        {
          p_author_tg_id: userId,
          p_category_slug: chosenCat.slug,
          p_kind: sess.k,
          p_media_type: sess.k === "media" ? sess.m.mt : null,
          p_tg_file_id: sess.k === "media" ? sess.m.f : null,
          p_text_body:
            sess.k === "text"
              ? sess.m.t.trim()
              : sess.m.x && sess.m.x.trim().length > 0
                ? sess.m.x.trim()
                : null,
          p_status: "published",
          p_channel_msg_id: null,
        }
      );

      if (rpcErr || !rpcRows || !rpcRows[0]) {
        throw new Error(rpcErr?.message || "RPC create_menfess_post failed");
      }

      const createdRow = rpcRows[0];

      const sentChannelMsg = await publishToChannel({
        channelId: CHANNEL_ID,
        publicCode: createdRow.public_code,
        categoryLabel: chosenCat.label,
        kind: sess.k,
        mediaType: sess.m.mt,
        fileId: sess.m.f,
        textBody: sess.k === "text" ? sess.m.t : sess.m.x || "",
        botUsername: BOT_USERNAME,
      });

      await Promise.all([
        supabase.rpc("set_menfess_channel_msg", {
          p_post_id: createdRow.id,
          p_channel_msg_id: sentChannelMsg.message_id,
          p_status: "published",
        }),
        clearSession(userId),
      ]);

      const safeCat = escapeHtml(chosenCat.label);
      const safeCode = Math.max(0, Number(createdRow.public_code) || 0);

      await tgCall("sendMessage", {
        chat_id: chatId,
        text:
          `✅ Menfess <b>#${safeCode}</b> (<b>#${safeCat}</b>) berhasil tayang di channel!\n` +
          `Sisa kuota hari ini: <b>${Math.max(0, quota.limit - quota.used)}/${quota.limit}</b>`,
        parse_mode: "HTML",
        reply_markup: mainMenuMarkup(),
      });
    } catch (err) {
      console.error("Publish menfess error:", err?.message || err);
      await Promise.all([
        refundDailyQuota(userId).catch(() => null),
        clearSession(userId).catch(() => null),
      ]);

      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Gagal menerbitkan menfess ke channel. Kuota Anda telah dikembalikan, silakan coba lagi.",
        parse_mode: "HTML",
        reply_markup: mainMenuMarkup(),
      }).catch(() => null);
    }
  }
}

async function handleMessage(msg) {
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (!userId || !chatId || msg.chat?.type !== "private") return;

  const rawText = typeof msg.text === "string" ? msg.text.trim() : "";

  if (rawText === "/start") {
    await clearSession(userId);
    const welcomeHtml =
      "<b>Selamat Datang di Bot Menfess</b>\n\n" +
      "Kirimkan pesan anonim ke channel tanpa membuka identitas Anda. Diskusi bisa langsung dilakukan lewat kolom komentar di channel.\n\n" +
      "Klik tombol di bawah untuk mulai mengirim.";

    await tgCall("sendMessage", {
      chat_id: chatId,
      text: welcomeHtml,
      parse_mode: "HTML",
      reply_markup: mainMenuMarkup(),
    });
    return;
  }

  if (rawText === "/cancel") {
    await clearSession(userId);
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: "Aksi dibatalkan. Ketik /start untuk membuka menu.",
      parse_mode: "HTML",
    });
    return;
  }

  const sess = await getSession(userId);
  if (!sess || sess.s !== "WAIT_INPUT") {
    return;
  }

  if (sess.k === "text") {
    if (!rawText) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Menfess teks tidak boleh kosong. Kirim pesan teks yang valid atau tekan /cancel.",
        parse_mode: "HTML",
      });
      return;
    }

    const cleanText = truncateText(rawText, 3500);
    const [categories] = await Promise.all([
      getActiveCategories(),
      setSession(userId, {
        s: "PICK_CAT",
        k: "text",
        m: { t: cleanText },
      }),
    ]);

    await tgCall("sendMessage", {
      chat_id: chatId,
      text: "<b>Pilih Kategori Menfess</b>:",
      parse_mode: "HTML",
      reply_markup: categoryMarkup(categories),
    });
    return;
  }

  if (sess.k === "media") {
    const media = extractMediaPayload(msg);
    if (!media) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Harap kirimkan <b>foto, video, GIF, atau dokumen</b> yang valid (atau /cancel untuk batal).",
        parse_mode: "HTML",
      });
      return;
    }

    const optionalCaption = truncateText(media.caption.trim(), 850);
    const [categories] = await Promise.all([
      getActiveCategories(),
      setSession(userId, {
        s: "PICK_CAT",
        k: "media",
        m: {
          mt: media.mediaType,
          f: media.fileId,
          x: optionalCaption,
        },
      }),
    ]);

    await tgCall("sendMessage", {
      chat_id: chatId,
      text: "<b>Pilih Kategori Menfess</b>:",
      parse_mode: "HTML",
      reply_markup: categoryMarkup(categories),
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  if (!isValidTelegramSecret(req, WEBHOOK_SECRET)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const update = req.body;
    if (!update || typeof update.update_id !== "number") {
      return res.status(200).json({ ok: true });
    }

    const firstSeen = await claimEventOnce(`upd:${update.update_id}`, 120);
    if (!firstSeen) {
      return res.status(200).json({ ok: true, dedup: true });
    }

    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook fatal guard:", err?.message || err);
    return res.status(200).json({ ok: true });
  }
}
