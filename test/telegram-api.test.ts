import assert from "node:assert/strict";
import { test } from "node:test";
import { nullLogger } from "../src/logger.js";
import { TelegramApi } from "../src/telegram/api.js";

test("Telegram API sends completion reactions with the Bot API shape", async () => {
  let requestUrl = "";
  let requestBody: unknown;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const api = new TelegramApi("test-token", nullLogger, fetchImpl);
  assert.equal(await api.setMessageReaction(10, 20, { type: "emoji", emoji: "👍" }), true);
  assert.match(requestUrl, /\/setMessageReaction$/u);
  assert.deepEqual(requestBody, {
    chat_id: 10,
    message_id: 20,
    reaction: [{ type: "emoji", emoji: "👍" }],
  });
});
