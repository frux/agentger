import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadItem } from "../src/app-server/generated/v2/ThreadItem.js";
import { splitTelegramText, TurnRenderer } from "../src/telegram/renderer.js";
import { StreamingMessage } from "../src/telegram/streaming-message.js";
import { TelegramTurnSink } from "../src/telegram/turn-sink.js";

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

function commandItem(status: "inProgress" | "completed" = "completed"): ThreadItem {
  return {
    type: "commandExecution",
    id: "command-1",
    pluginId: null,
    scriptPath: null,
    command: "/usr/bin/bash -lc \"sed -n '1,240p' /home/frux/.agents/skills/frux-voice/SKILL.md\"",
    cwd: "/home/frux",
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 100 : null,
  };
}

function agentItem(id: string, text: string): ThreadItem {
  return { type: "agentMessage", id, text, phase: null, memoryCitation: null };
}

test("renderer emits compact commands and tools without Codex status prefixes", () => {
  const renderer = new TurnRenderer();
  const command = renderer.consume({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: commandItem(), completedAtMs: 1 },
  });
  assert.deepEqual(command, [{
    key: "command:command-1",
    kind: "command",
    text: "```bash\n/usr/bin/bash -lc \"sed -n '1,240p' /home/frux/.agents/skills/frux-voice/SKILL.md\"\n```",
    completed: true,
    parseMode: "MarkdownV2",
  }]);

  const tool = renderer.consume({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1,
      item: {
        type: "mcpToolCall",
        id: "tool-1",
        server: "github",
        tool: "fetch_file",
        status: "inProgress",
        arguments: {},
        appContext: null,
        pluginId: null,
        result: null,
        error: null,
        durationMs: null,
      },
    },
  });
  assert.equal(tool[0]?.text, "🔧 github/fetch_file");
  assert.doesNotMatch(`${command[0]?.text}${tool[0]?.text}`, /Codex|Готово/u);
});

test("turn sink sends each activity separately and reacts to the final agent message", async () => {
  let nextId = 10;
  const sent: Array<{ id: number; text: string; options: unknown }> = [];
  const edits: Array<{ id: number; text: string }> = [];
  const reactions: Array<{ messageId: number; reaction: unknown }> = [];
  const telegram = {
    async sendMessage(_chatId: number, text: string, options?: unknown) {
      const message = { message_id: nextId++ };
      sent.push({ id: message.message_id, text, options });
      return message;
    },
    async editMessageText(_chatId: number, messageId: number, text: string) {
      edits.push({ id: messageId, text });
      return true;
    },
    async setMessageReaction(_chatId: number, messageId: number, reaction: unknown) {
      reactions.push({ messageId, reaction });
      return true as const;
    },
  };
  const sink = new TelegramTurnSink(telegram, 1, 2, {
    streamUpdateIntervalMs: 1,
    completionReactionCustomEmojiId: null,
  });
  sink.onNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: agentItem("agent-1", "Сначала проверю файлы."), completedAtMs: 1 },
  });
  sink.onNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: commandItem(), completedAtMs: 2 },
  });
  sink.onNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: agentItem("agent-2", "Изменения готовы."), completedAtMs: 3 },
  });
  sink.onNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [agentItem("agent-1", "Сначала проверю файлы."), commandItem(), agentItem("agent-2", "Изменения готовы.")],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1_000,
      },
    },
  });
  await sink.drain();

  assert.deepEqual(sent.map(({ text }) => text), [
    "Сначала проверю файлы.",
    "```bash\n/usr/bin/bash -lc \"sed -n '1,240p' /home/frux/.agents/skills/frux-voice/SKILL.md\"\n```",
    "Изменения готовы.",
  ]);
  assert.deepEqual(edits, []);
  assert.deepEqual(sent[1]?.options, { messageThreadId: 2, parseMode: "MarkdownV2" });
  assert.deepEqual(reactions, [{ messageId: 12, reaction: { type: "emoji", emoji: "👍" } }]);
});

test("turn sink uses the configured custom completion reaction", async () => {
  const reactions: unknown[] = [];
  const telegram = {
    async sendMessage() { return { message_id: 50 }; },
    async editMessageText() { return true; },
    async setMessageReaction(_chatId: number, _messageId: number, reaction: unknown) {
      reactions.push(reaction);
      return true as const;
    },
  };
  const sink = new TelegramTurnSink(telegram, 1, 2, {
    streamUpdateIntervalMs: 1,
    completionReactionCustomEmojiId: "checkmark-custom-emoji-id",
  });
  const item = agentItem("agent-1", "Готово без текстового статуса.");
  sink.onNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item, completedAtMs: 1 },
  });
  sink.onNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [item],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1_000,
      },
    },
  });
  await sink.drain();
  assert.deepEqual(reactions, [{ type: "custom_emoji", custom_emoji_id: "checkmark-custom-emoji-id" }]);
});
