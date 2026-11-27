import {
  claimEventOnce,
  consumeDailyQuota,
  refundDailyQuota,
  getEffectiveDailyQuota,
  getUserVipInfo,
  setUserVip,
  clearUserVip,
  runPeriodicDbSelfHeal,
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
  safeDeleteMessage,
  extractMediaPayload,
  publishToChannel,
  reportSystemError,
  reportAdminAudit,
} from "../src/lib/telegram.js";

const CHANNEL_ID = process.env.MENFESS_CHANNEL_ID;
const BOT_USERNAME = process.env.BOT_USERNAME || "";
const DAILY_QUOTA = Number(process.env.DAILY_QUOTA || 5);
const VIP_DAILY_QUOTA = Number(process.env.VIP_DAILY_QUOTA || 20);
const VIP_QR_FILE_ID = process.env.VIP_QR_FILE_ID || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const KEEP_DAYS = Number(process.env.DB_KEEP_DAYS || 30);
const PURGE_STATUSES = (process.env.DB_PURGE_STATUSES || "published,rejected")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const HEAL_LOCK_SECONDS = Number(process.env.DB_HEAL_LOCK_SECONDS || 3600);

const ADMIN_IDS = new Set(
  (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
);
const PRIMARY_ADMIN_ID = [...ADMIN_IDS][0] || 0;

const VIP_PACKAGES = {
  "3d": {
    code: "3d",
    days: 3,
    priceLabel: "Rp3.000",
    ttlSeconds: 3 * 86400,
    title: "VIP 3 Hari",
  },
  "7d": {
    code: "7d",
    days: 7,
    priceLabel: "Rp5.000",
    ttlSeconds: 7 * 86400,
    title: "VIP 7 Hari",
  },
};

function parseVipDuration(rawDur) {
  const cleaned = String(rawDur || "3d")
    .trim()
    .toLowerCase();
  if (cleaned === "3" || cleaned === "3d") {
    return VIP_PACKAGES["3d"];
  }
  if (cleaned === "7" || cleaned === "7d") {
    return VIP_PACKAGES["7d"];
  }
  return null;
}

function mainMenuMarkup() {
  return {
    inline_keyboard: [
      [{ text: "✉️ Kirim Menfess", callback_data: "mf:open" }],
      [{ text: "⭐ Paket VIP", callback_data: "vip:menu" }],
    ],
  };
}

function vipPackagesMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "⭐ 3 Hari · Rp3.000", callback_data: "vip:buy:3d" },
        { text: "🌟 7 Hari · Rp5.000", callback_data: "vip:buy:7d" },
      ],
      [{ text: "⬅️ Kembali ke Menu", callback_data: "mf:home" }],
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
    tgCall("answerCallbackQuery", { callback_query_id: cqId }).catch((e) => {
      reportSystemError("answer_callback_query", e, `userId=${userId}`).catch(
        () => null
      );
      return null;
    }),
  ]);

  if (!isUnique) return;

  if (data.startsWith("vip:ok:") || data.startsWith("vip:no:")) {
    if (!ADMIN_IDS.has(userId)) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Aksi ini khusus admin.",
        parse_mode: "HTML",
      }).catch(() => null);
      return;
    }

    const parts = data.split(":");
    const action = parts[1];
    const targetId = Number(parts[2]);
    const durCode = parts[3] === "7d" ? "7d" : "3d";
    const parsedDur = parseVipDuration(durCode);

    if (!Number.isSafeInteger(targetId) || targetId <= 0 || !parsedDur) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Data tombol VIP tidak valid.",
        parse_mode: "HTML",
      }).catch(() => null);
      return;
    }

    const lockKey = `vipact:${chatId}:${msgId}`;
    const canAct = await claimEventOnce(lockKey, 86400).catch(() => true);
    if (!canAct) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Pengajuan VIP pada pesan ini sudah diproses sebelumnya.",
        parse_mode: "HTML",
      }).catch(() => null);
      return;
    }

    const oldCaption =
      typeof cq.message?.caption === "string" ? cq.message.caption : "";

    if (action === "no") {
      try {
        await tgCall("editMessageCaption", {
          chat_id: chatId,
          message_id: msgId,
          caption: `${truncateText(oldCaption, 780)}\n\n❌ <b>DITOLAK</b> oleh admin <code>${userId}</code>`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        }).catch(() => null);

        await tgCall("sendMessage", {
          chat_id: targetId,
          text:
            "⚠️ <b>Pengajuan VIP Ditolak</b>\n\n" +
            "Bukti transaksi belum sesuai atau belum terverifikasi. Silakan periksa kembali pembayaran Anda atau hubungi admin.",
          parse_mode: "HTML",
        }).catch(() => null);

        await reportAdminAudit(
          "VIP_REJECTED",
          `by=${userId} target=${targetId} pkg=${parsedDur.code}`
        );
      } catch (err) {
        await reportSystemError(
          "admin_reject_vip_btn",
          err,
          `by=${userId} target=${targetId}`
        ).catch(() => null);
      }
      return;
    }

    try {
      const expiresAtIso = new Date(
        Date.now() + parsedDur.ttlSeconds * 1000
      ).toISOString();

      await setUserVip(targetId, parsedDur.ttlSeconds, {
        tier: `vip_${parsedDur.code}`,
        days: parsedDur.days,
        grantedBy: userId,
        expiresAt: expiresAtIso,
      });

      let dmNotified = false;
      try {
        await tgCall("sendMessage", {
          chat_id: targetId,
          text:
            `⭐ <b>Status VIP Aktif!</b>\n\n` +
            `Paket VIP Anda telah diaktifkan selama <b>${parsedDur.days} hari</b>.\n` +
            `🎟 Kuota menfess harian Anda kini menjadi <b>${Math.max(DAILY_QUOTA, VIP_DAILY_QUOTA)}/hari</b>.\n` +
            `⏳ Berlaku sampai: <code>${escapeHtml(expiresAtIso)}</code>`,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
        dmNotified = true;
      } catch (dmErr) {
        reportSystemError(
          "vip_dm_notify_btn",
          dmErr,
          `by=${userId} target=${targetId} dur=${parsedDur.code}`
        ).catch(() => null);
      }

      await tgCall("editMessageCaption", {
        chat_id: chatId,
        message_id: msgId,
        caption:
          `${truncateText(oldCaption, 760)}\n\n` +
          `✅ <b>DISETUJUI (${parsedDur.code})</b> oleh admin <code>${userId}</code>\n` +
          `📩 DM user: <b>${dmNotified ? "Terkirim" : "Gagal"}</b>`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      }).catch(() => null);

      await reportAdminAudit(
        "VIP_GRANTED_BTN",
        `by=${userId} target=${targetId} duration=${parsedDur.code} dm=${dmNotified ? "ok" : "failed"} exp=${expiresAtIso}`
      );
    } catch (err) {
      await reportSystemError(
        "admin_grant_vip_btn",
        err,
        `by=${userId} target=${targetId} dur=${parsedDur.code}`
      ).catch(() => null);
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Gagal mengaktifkan VIP lewat tombol. Cek log [MFS].",
        parse_mode: "HTML",
      }).catch(() => null);
    }
    return;
  }

  if (data === "mf:cancel" || data === "mf:home") {
    const prevSess = await getSession(userId);
    await Promise.all([
      clearSession(userId),
      safeDeleteMessage(chatId, msgId),
      prevSess?.pm && prevSess.pm !== msgId
        ? safeDeleteMessage(chatId, prevSess.pm)
        : Promise.resolve(false),
    ]);
    await tgCall("sendMessage", {
      chat_id: chatId,
      text:
        data === "mf:home"
          ? "<b>Menu Utama Menfess</b>\n\nSilakan pilih aksi di bawah."
          : "Pengiriman menfess dibatalkan.",
      parse_mode: "HTML",
      reply_markup: mainMenuMarkup(),
    });
    return;
  }

  if (data === "vip:menu") {
    const effectiveVipQuota = Math.max(DAILY_QUOTA, VIP_DAILY_QUOTA);
    const detailHtml =
      "<b>⭐ Detail Paket VIP Menfess</b>\n\n" +
      `• <b>Kuota VIP:</b> hingga <b>${effectiveVipQuota} menfess / hari</b>\n` +
      "• <b>Paket 3 Hari:</b> <b>Rp3.000</b>\n" +
      "• <b>Paket 7 Hari:</b> <b>Rp5.000</b>\n\n" +
      "Pilih paket di bawah untuk mendapatkan QR pembayaran &amp; kirim bukti transfer:";

    const sent = await tgCall("sendMessage", {
      chat_id: chatId,
      text: detailHtml,
      parse_mode: "HTML",
      reply_markup: vipPackagesMarkup(),
    });

    await Promise.all([
      clearSession(userId),
      safeDeleteMessage(chatId, msgId),
      sent?.message_id
        ? setSession(userId, { s: "PICK_VIP", pm: sent.message_id })
        : Promise.resolve(),
    ]);
    return;
  }

  if (data === "vip:buy:3d" || data === "vip:buy:7d") {
    const pkgKey = data.endsWith(":7d") ? "7d" : "3d";
    const pkg = VIP_PACKAGES[pkgKey];

    await safeDeleteMessage(chatId, msgId);

    const captionHtml =
      `<b>💳 Pembayaran ${escapeHtml(pkg.title)}</b>\n\n` +
      `• <b>Paket:</b> ${escapeHtml(pkg.title)} (${pkg.days} hari)\n` +
      `• <b>Nominal:</b> <b>${escapeHtml(pkg.priceLabel)}</b>\n` +
      `• <b>Kuota VIP:</b> hingga <b>${Math.max(DAILY_QUOTA, VIP_DAILY_QUOTA)}/hari</b>\n\n` +
      "Scan QR di atas, lakukan transfer sesuai nominal, lalu <b>kirim foto/dokumen bukti transaksi</b> ke chat ini (atau tekan /cancel untuk batal).";

    let sent = null;
    if (VIP_QR_FILE_ID) {
      sent = await tgCall("sendPhoto", {
        chat_id: chatId,
        photo: VIP_QR_FILE_ID,
        caption: captionHtml,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "❌ Batal", callback_data: "mf:cancel" }]],
        },
      });
    } else {
      sent = await tgCall("sendMessage", {
        chat_id: chatId,
        text:
          captionHtml +
          "\n\n<i>(QR belum dikonfigurasi oleh admin—kirim bukti transfer atau hubungi admin.)</i>",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "❌ Batal", callback_data: "mf:cancel" }]],
        },
      });
    }

    await setSession(userId, {
      s: "WAIT_VIP_PROOF",
      pkg: pkg.code,
      pm: sent?.message_id,
    });
    return;
  }

  if (data === "mf:open") {
    const sent = await tgCall("sendMessage", {
      chat_id: chatId,
      text:
        "<b>Pilih Jenis Menfess</b>\n\n" +
        "• <b>Menfess Teks</b>: wajib isi teks.\n" +
        "• <b>Menfess Media</b>: foto/video/dokumen/GIF, teks/caption boleh kosong.",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📝 Menfess Teks", callback_data: "mf:kind:text" },
            { text: "🖼 Menfess Media", callback_data: "mf:kind:media" },
          ],
          [{ text: "❌ Batal", callback_data: "mf:cancel" }],
        ],
      },
    });

    await Promise.all([
      setSession(userId, { s: "PICK_KIND", pm: sent?.message_id }),
      safeDeleteMessage(chatId, msgId),
    ]);
    return;
  }

  if (data === "mf:kind:text" || data === "mf:kind:media") {
    const kind = data === "mf:kind:text" ? "text" : "media";
    const promptHtml =
      kind === "text"
        ? "<b>Mode: Menfess Teks</b>\n\nSilakan kirimkan isi pesan teks Anda (maksimal 3500 karakter). Teks tidak boleh kosong."
        : "<b>Mode: Menfess Media</b>\n\nSilakan kirimkan foto, video, GIF, atau dokumen. Caption/teks bersifat <b>opsional</b> (boleh dikosongkan).";

    const sent = await tgCall("sendMessage", {
      chat_id: chatId,
      text: promptHtml,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "❌ Batal", callback_data: "mf:cancel" }]],
      },
    });

    await Promise.all([
      setSession(userId, { s: "WAIT_INPUT", k: kind, pm: sent?.message_id }),
      safeDeleteMessage(chatId, msgId),
    ]);
    return;
  }

  if (data.startsWith("mf:cat:")) {
    const slug = data.slice(7);
    const [sess, categories, vipInfo] = await Promise.all([
      getSession(userId),
      getActiveCategories(),
      getUserVipInfo(userId).catch(() => ({
        isVip: false,
        expiresAt: null,
        remainingText: "",
      })),
    ]);

    const chosenCat = categories.find((c) => c.slug === slug);
    if (!sess || sess.s !== "PICK_CAT" || !chosenCat || !sess.m) {
      await Promise.all([
        safeDeleteMessage(chatId, msgId),
        sess?.pm && sess.pm !== msgId
          ? safeDeleteMessage(chatId, sess.pm)
          : Promise.resolve(false),
        tgCall("sendMessage", {
          chat_id: chatId,
          text: "Sesi sudah berakhir atau tidak valid. Mulai lagi dengan /start.",
          parse_mode: "HTML",
          reply_markup: mainMenuMarkup(),
        }),
      ]);
      return;
    }

    if (sess.k === "text" && (!sess.m.t || !sess.m.t.trim())) {
      await Promise.all([
        setSession(userId, { s: "WAIT_INPUT", k: "text", pm: sess.pm }),
        safeDeleteMessage(chatId, msgId),
        tgCall("sendMessage", {
          chat_id: chatId,
          text: "Menfess teks tidak boleh kosong. Silakan kirim teks Anda.",
          parse_mode: "HTML",
        }),
      ]);
      return;
    }

    if (!CHANNEL_ID) {
      await Promise.all([
        clearSession(userId),
        safeDeleteMessage(chatId, msgId),
        sess.pm && sess.pm !== msgId
          ? safeDeleteMessage(chatId, sess.pm)
          : Promise.resolve(false),
        reportSystemError(
          "missing_channel_id",
          "MENFESS_CHANNEL_ID is not configured",
          `userId=${userId}`
        ).catch(() => null),
      ]);
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Konfigurasi channel tujuan belum tersedia. Silakan hubungi admin.",
        parse_mode: "HTML",
        reply_markup: mainMenuMarkup(),
      });
      return;
    }

    const effectiveLimit = getEffectiveDailyQuota(
      vipInfo.isVip,
      DAILY_QUOTA,
      VIP_DAILY_QUOTA
    );
    const quota = await consumeDailyQuota(userId, effectiveLimit);
    if (!quota.allowed) {
      await Promise.all([
        clearSession(userId),
        safeDeleteMessage(chatId, msgId),
        sess.pm && sess.pm !== msgId
          ? safeDeleteMessage(chatId, sess.pm)
          : Promise.resolve(false),
      ]);

      const vipHint = vipInfo.isVip
        ? ""
        : `\n\n⭐ Butuh kirim lebih banyak? Kuota VIP hingga <b>${Math.max(DAILY_QUOTA, VIP_DAILY_QUOTA)}/hari</b> (3 Hari Rp3.000 / 7 Hari Rp5.000). Buka <b>⭐ Paket VIP</b> untuk aktivasi.`;

      await tgCall("sendMessage", {
        chat_id: chatId,
        text: `Kuota menfess harian Anda sudah habis (<b>${quota.used}/${quota.limit}</b>). Silakan coba lagi besok.${vipHint}`,
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

      const { error: updateMsgErr } = await supabase.rpc(
        "set_menfess_channel_msg",
        {
          p_post_id: createdRow.id,
          p_channel_msg_id: sentChannelMsg.message_id,
          p_status: "published",
        }
      );

      if (updateMsgErr) {
        reportSystemError(
          "set_menfess_channel_msg",
          updateMsgErr.message,
          `postId=${createdRow.id} chMsgId=${sentChannelMsg.message_id}`
        ).catch(() => null);
      }

      await Promise.all([
        clearSession(userId),
        safeDeleteMessage(chatId, msgId),
        sess.pm && sess.pm !== msgId
          ? safeDeleteMessage(chatId, sess.pm)
          : Promise.resolve(false),
      ]);

      const safeCat = escapeHtml(chosenCat.label);
      const safeCode = Math.max(0, Number(createdRow.public_code) || 0);
      const sisaKuota = Math.max(0, quota.limit - quota.used);

      const vipLine = vipInfo.isVip
        ? `⭐ <b>VIP</b>${vipInfo.remainingText ? ` (sisa <b>${escapeHtml(vipInfo.remainingText)}</b>)` : ""}\n`
        : "";

      await tgCall("sendMessage", {
        chat_id: chatId,
        text:
          `✅ <b>Menfess #${safeCode}</b> terkirim ke kategori <b>#${safeCat}</b>.\n` +
          `💬 Balasan &amp; diskusi tersedia di kolom komentar channel.\n` +
          vipLine +
          `🎟 Sisa kuota hari ini: <b>${sisaKuota}/${quota.limit}</b>`,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: mainMenuMarkup(),
      });
    } catch (err) {
      console.error("[MFS] Publish menfess error:", err?.message || err);

      await Promise.all([
        refundDailyQuota(userId).catch((refErr) => {
          reportSystemError(
            "refund_daily_quota",
            refErr,
            `userId=${userId}`
          ).catch(() => null);
          return null;
        }),
        clearSession(userId).catch(() => null),
        safeDeleteMessage(chatId, msgId),
        sess.pm && sess.pm !== msgId
          ? safeDeleteMessage(chatId, sess.pm)
          : Promise.resolve(false),
        reportSystemError(
          "publish_menfess",
          err,
          `userId=${userId} kind=${sess.k} cat=${chosenCat.slug}`
        ).catch(() => null),
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

  if (
    rawText === "/vip" ||
    rawText.startsWith("/vip ") ||
    rawText === "/unvip" ||
    rawText.startsWith("/unvip ")
  ) {
    if (!ADMIN_IDS.has(userId)) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Perintah ini khusus admin.",
        parse_mode: "HTML",
      });
      return;
    }

    const parts = rawText.split(/\s+/).filter(Boolean);
    const cmd = parts[0];
    const targetId = Number(parts[1]);

    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text:
          "Format salah.\n" +
          "Gunakan: <code>/vip &lt;user_id&gt; 3d</code> atau <code>/vip &lt;user_id&gt; 7d</code>\n" +
          "Atau cabut: <code>/unvip &lt;user_id&gt;</code>",
        parse_mode: "HTML",
      });
      return;
    }

    if (cmd === "/unvip") {
      try {
        await clearUserVip(targetId);
        await reportAdminAudit(
          "VIP_REVOKED",
          `by=${userId} target=${targetId}`
        );
        await tgCall("sendMessage", {
          chat_id: chatId,
          text: `Status VIP untuk user <code>${targetId}</code> telah dicabut.`,
          parse_mode: "HTML",
        });
      } catch (err) {
        await reportSystemError(
          "admin_unvip",
          err,
          `by=${userId} target=${targetId}`
        ).catch(() => null);
        await tgCall("sendMessage", {
          chat_id: chatId,
          text: "Gagal mencabut status VIP. Cek log [MFS].",
          parse_mode: "HTML",
        });
      }
      return;
    }

    const parsedDur = parseVipDuration(parts[2] || "3d");
    if (!parsedDur) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Durasi tidak valid. Paket VIP hanya tersedia untuk <code>3d</code> (3 hari) atau <code>7d</code> (7 hari).",
        parse_mode: "HTML",
      });
      return;
    }

    try {
      const expiresAtIso = new Date(
        Date.now() + parsedDur.ttlSeconds * 1000
      ).toISOString();

      await setUserVip(targetId, parsedDur.ttlSeconds, {
        tier: `vip_${parsedDur.code}`,
        days: parsedDur.days,
        grantedBy: userId,
        expiresAt: expiresAtIso,
      });

      let dmNotified = false;
      try {
        await tgCall("sendMessage", {
          chat_id: targetId,
          text:
            `⭐ <b>Status VIP Aktif!</b>\n\n` +
            `Paket VIP Anda telah diaktifkan selama <b>${parsedDur.days} hari</b>.\n` +
            `🎟 Kuota menfess harian Anda kini menjadi <b>${Math.max(DAILY_QUOTA, VIP_DAILY_QUOTA)}/hari</b>.\n` +
            `⏳ Berlaku sampai: <code>${escapeHtml(expiresAtIso)}</code>`,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
        dmNotified = true;
      } catch (dmErr) {
        reportSystemError(
          "vip_dm_notify",
          dmErr,
          `by=${userId} target=${targetId} dur=${parsedDur.code}`
        ).catch(() => null);
      }

      await reportAdminAudit(
        "VIP_GRANTED",
        `by=${userId} target=${targetId} duration=${parsedDur.code} dm=${dmNotified ? "ok" : "failed"} exp=${expiresAtIso}`
      );

      await tgCall("sendMessage", {
        chat_id: chatId,
        text:
          `✅ VIP aktif untuk user <code>${targetId}</code> selama <b>${parsedDur.days} hari</b>.\n` +
          `📩 Notifikasi ke user: <b>${dmNotified ? "Terkirim" : "Gagal (cek log [MFS])"}</b>\n` +
          `Kedaluwarsa: <code>${escapeHtml(expiresAtIso)}</code>`,
        parse_mode: "HTML",
      });
    } catch (err) {
      await reportSystemError(
        "admin_grant_vip",
        err,
        `by=${userId} target=${targetId} dur=${parsedDur.code}`
      ).catch(() => null);
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Gagal mengaktifkan VIP. Cek log [MFS].",
        parse_mode: "HTML",
      });
    }
    return;
  }

  if (rawText === "/start") {
    const prevSess = await getSession(userId);
    await Promise.all([
      clearSession(userId),
      safeDeleteMessage(chatId, prevSess?.pm),
    ]);

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
    const prevSess = await getSession(userId);
    await Promise.all([
      clearSession(userId),
      safeDeleteMessage(chatId, prevSess?.pm),
    ]);
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: "Aksi dibatalkan. Ketik /start untuk membuka menu.",
      parse_mode: "HTML",
      reply_markup: mainMenuMarkup(),
    });
    return;
  }

  const sess = await getSession(userId);
  if (!sess) {
    return;
  }

  if (sess.s === "WAIT_VIP_PROOF") {
    const proofMedia = extractMediaPayload(msg);
    if (
      !proofMedia ||
      (proofMedia.mediaType !== "photo" && proofMedia.mediaType !== "document")
    ) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Harap kirimkan <b>foto atau dokumen bukti transaksi</b> yang valid (atau /cancel untuk batal).",
        parse_mode: "HTML",
      });
      return;
    }

    const pkg = VIP_PACKAGES[sess.pkg] || VIP_PACKAGES["3d"];
    const usernameTag = msg.from?.username
      ? `@${escapeHtml(msg.from.username)}`
      : "-";
    const fullName = escapeHtml(
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
        "User"
    );

    const draftCaption =
      `<b>🧾 [MFS] Draft Pengajuan VIP</b>\n\n` +
      `• <b>User ID:</b> <code>${userId}</code>\n` +
      `• <b>Nama:</b> ${fullName}\n` +
      `• <b>Username:</b> ${usernameTag}\n` +
      `• <b>Paket:</b> <b>${escapeHtml(pkg.title)}</b> (${escapeHtml(pkg.priceLabel)})\n\n` +
      `Cek mutasi/m-banking, lalu aktifkan dengan tombol di bawah atau perintah:\n` +
      `<code>/vip ${userId} ${pkg.code}</code>`;

    const adminTargets =
      ADMIN_IDS.size > 0
        ? [...ADMIN_IDS]
        : PRIMARY_ADMIN_ID
          ? [PRIMARY_ADMIN_ID]
          : [];

    const vipReviewMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Aktifkan 3d", callback_data: `vip:ok:${userId}:3d` },
          { text: "✅ Aktifkan 7d", callback_data: `vip:ok:${userId}:7d` },
        ],
        [{ text: "❌ Tolak", callback_data: `vip:no:${userId}:${pkg.code}` }],
      ],
    };

    const method = proofMedia.mediaType === "photo" ? "sendPhoto" : "sendDocument";
    const field = proofMedia.mediaType === "photo" ? "photo" : "document";

    await Promise.all([
      clearSession(userId),
      safeDeleteMessage(chatId, sess.pm),
      ...adminTargets.map((admId) =>
        tgCall(method, {
          chat_id: admId,
          [field]: proofMedia.fileId,
          caption: draftCaption,
          parse_mode: "HTML",
          reply_markup: vipReviewMarkup,
        }).catch((admErr) =>
          reportSystemError(
            "vip_draft_to_admin",
            admErr,
            `adminId=${admId} userId=${userId} pkg=${pkg.code}`
          ).catch(() => null)
        )
      ),
      reportAdminAudit(
        "VIP_PROOF_SUBMITTED",
        `user=${userId} pkg=${pkg.code} price=${pkg.priceLabel}`
      ).catch(() => null),
    ]);

    await tgCall("sendMessage", {
      chat_id: chatId,
      text:
        `✅ <b>Bukti transaksi (${escapeHtml(pkg.title)} · ${escapeHtml(pkg.priceLabel)}) telah dikirim ke admin.</b>\n` +
        "Silakan tunggu konfirmasi dan pencocokan pembayaran oleh admin.",
      parse_mode: "HTML",
      reply_markup: mainMenuMarkup(),
    });
    return;
  }

  if (sess.s !== "WAIT_INPUT") {
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
      safeDeleteMessage(chatId, sess.pm),
    ]);

    const sent = await tgCall("sendMessage", {
      chat_id: chatId,
      text: "<b>Pilih Kategori Menfess</b>:",
      parse_mode: "HTML",
      reply_markup: categoryMarkup(categories),
    });

    await setSession(userId, {
      s: "PICK_CAT",
      k: "text",
      pm: sent?.message_id,
      m: { t: cleanText },
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
      safeDeleteMessage(chatId, sess.pm),
    ]);

    const sent = await tgCall("sendMessage", {
      chat_id: chatId,
      text: "<b>Pilih Kategori Menfess</b>:",
      parse_mode: "HTML",
      reply_markup: categoryMarkup(categories),
    });

    await setSession(userId, {
      s: "PICK_CAT",
      k: "media",
      pm: sent?.message_id,
      m: {
        mt: media.mediaType,
        f: media.fileId,
        x: optionalCaption,
      },
    });
  }
}

  if (rawText === "/fileid" || rawText.startsWith("/fileid ")) {
    if (!ADMIN_IDS.has(userId)) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Perintah ini khusus admin.",
        parse_mode: "HTML",
      });
      return;
    }

    const targetMsg = msg.reply_to_message || msg;
    const media = extractMediaPayload(targetMsg);

    if (!media || !media.fileId) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "Kirim foto/media dengan caption <code>/fileid</code> atau balas (<i>reply</i>) pesan foto menggunakan <code>/fileid</code>.",
        parse_mode: "HTML",
      });
      return;
    }

    await tgCall("sendMessage", {
      chat_id: chatId,
      text:
        `<b>📎 Media Info (${escapeHtml(media.mediaType)})</b>\n\n` +
        `<code>${escapeHtml(media.fileId)}</code>`,
      parse_mode: "HTML",
    });
    return;
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

    await Promise.allSettled([
      update.callback_query
        ? handleCallback(update.callback_query)
        : update.message
          ? handleMessage(update.message)
          : Promise.resolve(),
      runPeriodicDbSelfHeal(KEEP_DAYS, PURGE_STATUSES, HEAL_LOCK_SECONDS),
    ]);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[MFS] Webhook fatal guard:", err?.message || err);
    await reportSystemError("webhook_fatal", err).catch(() => null);
    return res.status(200).json({ ok: true });
  }
}
