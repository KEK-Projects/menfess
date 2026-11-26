import test from "node:test";
import assert from "node:assert/strict";
import { isValidTelegramSecret } from "../src/lib/security.js";
import { escapeHtml } from "../src/lib/infra.js";
import { extractMediaPayload, buildChannelHtml } from "../src/lib/telegram.js";

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
      { headers: { "x-telegram-bot-api-secret-token": "tg_secret_token_9876543210_abcdeg" } },
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
