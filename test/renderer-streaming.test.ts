import assert from "node:assert/strict";
import { test } from "node:test";
import { splitTelegramText } from "../src/telegram/renderer.js";
import { StreamingMessage } from "../src/telegram/streaming-message.js";

test("Telegram text splitting preserves all content within limits", () => {
  const text = `${"a".repeat(3_500)}\n${"b".repeat(3_500)}\n${"c".repeat(1_000)}`;
  const parts = splitTelegramText(text, 4_000);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((part) => part.length <= 4_000));
  assert.equal(parts.join("\n"), text);
});

test("streaming updates are debounced to the latest edit", async () => {
  const edits: string[] = [];
  const api = {
    async sendMessage() { return { message_id: 9 }; },
    async editMessageText(_chatId: number, _messageId: number, text: string) { edits.push(text); },
  };
  const message = new StreamingMessage(api, 1, 2, 40);
  await message.start("initial");
  message.update("one");
  message.update("two");
  message.update("three");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(edits, ["three"]);
  await message.finish("final");
  assert.deepEqual(edits, ["three", "final"]);
});
