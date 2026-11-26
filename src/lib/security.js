import crypto from "node:crypto";

export function isValidTelegramSecret(req, expectedSecret) {
  if (typeof expectedSecret !== "string" || expectedSecret.length === 0) {
    return false;
  }

  const rawHeader = req?.headers?.["x-telegram-bot-api-secret-token"];
  const received = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  if (typeof received !== "string" || received.length === 0) {
    return false;
  }

  const receivedBuf = Buffer.from(received, "utf8");
  const expectedBuf = Buffer.from(expectedSecret, "utf8");

  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuf, expectedBuf);
}
