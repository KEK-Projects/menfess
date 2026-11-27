import test from "node:test";
import assert from "node:assert/strict";
import { isValidTelegramSecret } from "../src/lib/security.js";
import { escapeHtml, runPeriodicDbSelfHeal } from "../src/lib/infra.js";
import {
  extractMediaPayload,
  buildChannelHtml,
  reportSystemError,
} from "../src/lib/telegram.js";

test("Security: isValidTelegramSecret menolak input tidak valid & menerima token cocok", () => {
  const secret = "tg_secret_token_9876543210_abcdef";

  assert.equal(
    isValidTelegramSecret(
      { headers: { "x-telegram-bot-api-secret-token": secret } },
      secret
    ),
    true
  );

  assert.equal(
    isValidTelegramSecret(
      {
        headers: {
          "x-telegram-bot-api-secret-token": "tg_secret_token_9876543210_abcdeg",
        },
      },
      secret
    ),
    false
  );

  assert.equal(
    isValidTelegramSecret(
      { headers: { "x-telegram-bot-api-secret-token": "short" } },
      secret
    ),
    false
  );

  assert.equal(
    isValidTelegramSecret(
      { headers: { "x-telegram-bot-api-secret-token": "" } },
      secret
    ),
    false
  );

  assert.equal(isValidTelegramSecret({ headers: {} }, secret), false);
  assert.equal(
    isValidTelegramSecret(
      { headers: { "x-telegram-bot-api-secret-token": secret } },
      ""
    ),
    false
  );
});

test("HTML & Media: escapeHtml aman dan media tanpa caption diperbolehkan", () => {
  assert.equal(
    escapeHtml(`<a href="x">1 & 2</a>`),
    `&lt;a href=&quot;x&quot;&gt;1 &amp; 2&lt;/a&gt;`
  );

  const photoNoCaption = extractMediaPayload({
    photo: [{ file_id: "photo_small" }, { file_id: "photo_best" }],
  });
  assert.deepEqual(photoNoCaption, {
    mediaType: "photo",
    fileId: "photo_best",
    caption: "",
  });

  const htmlMediaNoCap = buildChannelHtml({
    publicCode: 12,
    categoryLabel: "Curhat",
    kind: "media",
    textBody: "",
    botUsername: "@BotKu",
  });
  assert.equal(
    htmlMediaNoCap,
    "<b>#Curhat</b> · <b>#12</b>\n\n<i>Kirim lewat @BotKu · Komentar di bawah</i>"
  );

  const htmlTextEscaped = buildChannelHtml({
    publicCode: 13,
    categoryLabel: "Saran",
    kind: "text",
    textBody: "A < B & C > D",
    botUsername: "BotKu",
  });
  assert.equal(
    htmlTextEscaped,
    "<b>#Saran</b> · <b>#13</b>\n\nA &lt; B &amp; C &gt; D\n\n<i>Kirim lewat @BotKu · Komentar di bawah</i>"
  );
});

test("Self-heal: meneruskan durasi lock (dengan clamp) dan filter status ke RPC", async () => {
  const setCalls = [];
  const rpcCalls = [];

  const mockRedis = {
    async set(key, val, opts) {
      setCalls.push({ key, val, opts });
      return "OK";
    },
  };

  const mockSupabase = {
    async rpc(fnName, params) {
      rpcCalls.push({ fnName, params });
      return { data: 5, error: null };
    },
  };

  const ok = await runPeriodicDbSelfHeal(14, ["published"], 7200, {
    redis: mockRedis,
    supabase: mockSupabase,
  });

  assert.equal(ok, true);
  assert.deepEqual(setCalls[0], {
    key: "heal:db:lock",
    val: "1",
    opts: { nx: true, ex: 7200 },
  });
  assert.deepEqual(rpcCalls[0], {
    fnName: "purge_old_menfess_posts",
    params: {
      p_keep_days: 14,
      p_statuses: ["published"],
    },
  });
});

test("Error Log [MFS]: format pesan aman HTML, kirim ke -1001778725181, dan deduplikasi aktif", async () => {
  const sentCalls = [];
  const seenKeys = new Set();

  const mockClaimOnce = async (key, ttlSec) => {
    assert.equal(ttlSec, 60);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  };

  const mockTgCall = async (method, payload) => {
    sentCalls.push({ method, payload });
    return { message_id: sentCalls.length };
  };

  const deps = {
    tgCall: mockTgCall,
    claimEventOnce: mockClaimOnce,
    logChannelId: "-1001778725181",
  };

  const firstSent = await reportSystemError(
    "publish_menfess",
    new Error('Bad tag <script> & "quote"'),
    "userId=12345 cat=random",
    deps
  );

  assert.equal(firstSent, true);
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].method, "sendMessage");
  assert.equal(sentCalls[0].payload.chat_id, "-1001778725181");
  assert.equal(sentCalls[0].payload.parse_mode, "HTML");
  assert.ok(sentCalls[0].payload.text.includes("[MFS]"));
  assert.ok(sentCalls[0].payload.text.includes("publish_menfess"));
  assert.ok(sentCalls[0].payload.text.includes("userId=12345 cat=random"));
  assert.ok(
    sentCalls[0].payload.text.includes(
      "Bad tag &lt;script&gt; &amp; &quot;quote&quot;"
    )
  );
  assert.ok(!sentCalls[0].payload.text.includes("<script>"));

  const duplicateSent = await reportSystemError(
    "publish_menfess",
    new Error('Bad tag <script> & "quote"'),
    "userId=12345 cat=random",
    deps
  );

  assert.equal(duplicateSent, false);
  assert.equal(sentCalls.length, 1);

  const differentSent = await reportSystemError(
    "db_self_heal_rpc",
    "permission denied for function purge_old_menfess_posts",
    "keepDays=30",
    deps
  );

  assert.equal(differentSent, true);
  assert.equal(sentCalls.length, 2);
});
