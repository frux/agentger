import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadItem } from "../src/app-server/generated/v2/ThreadItem.js";
import { nullLogger } from "../src/logger.js";
import { splitTelegramText, TurnRenderer } from "../src/telegram/renderer.js";
import { StreamingMessage } from "../src/telegram/streaming-message.js";
import { TelegramTurnSink } from "../src/telegram/turn-sink.js";
import { TypingIndicator } from "../src/telegram/typing-indicator.js";

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

test("silent streaming messages keep notifications disabled across split parts", async () => {
  const options: unknown[] = [];
  const api = {
    async sendMessage(_chatId: number, _text: string, sendOptions?: unknown) {
      options.push(sendOptions);
      return { message_id: options.length };
    },
    async editMessageText() { return true; },
  };
  const message = new StreamingMessage(api, 1, 2, 1, undefined, true);
  await message.finish("x".repeat(4_500));
  assert.deepEqual(options, [
    { messageThreadId: 2, disableNotification: true },
    { messageThreadId: 2, disableNotification: true },
  ]);
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
    format: "MarkdownV2",
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
  const richSent: Array<{ id: number; markdown: string; options: unknown }> = [];
  const richEdits: Array<{ id: number; markdown: string }> = [];
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
    async sendRichMessage(_chatId: number, markdown: string, options?: unknown) {
      const message = { message_id: nextId++ };
      richSent.push({ id: message.message_id, markdown, options });
      return message;
    },
    async editRichMessage(_chatId: number, messageId: number, markdown: string) {
      richEdits.push({ id: messageId, markdown });
      return true;
    },
    async setMessageReaction(_chatId: number, messageId: number, reaction: unknown) {
      reactions.push({ messageId, reaction });
      return true as const;
    },
    async sendChatAction() { return true as const; },
  };
  const sink = new TelegramTurnSink(telegram, 1, 2, {
    streamUpdateIntervalMs: 1,
    completionReactionCustomEmojiId: null,
    inboundMessageId: 7,
  });
  sink.onInputAccepted();
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
    "```bash\n/usr/bin/bash -lc \"sed -n '1,240p' /home/frux/.agents/skills/frux-voice/SKILL.md\"\n```",
  ]);
  assert.deepEqual(richSent, [
    { id: 10, markdown: "Сначала проверю файлы.", options: { messageThreadId: 2 } },
    { id: 12, markdown: "Изменения готовы.", options: { messageThreadId: 2 } },
  ]);
  assert.deepEqual(edits, []);
  assert.deepEqual(richEdits, []);
  assert.deepEqual(sent[0]?.options, {
    messageThreadId: 2,
    parseMode: "MarkdownV2",
    disableNotification: true,
  });
  assert.deepEqual(reactions, [
    { messageId: 7, reaction: { type: "emoji", emoji: "👀" } },
    { messageId: 12, reaction: { type: "emoji", emoji: "👍" } },
  ]);
});

test("completed agent Markdown is sent as a Telegram rich message unchanged", async () => {
  const markdown = [
    "Готово, запись подтверждена:",
    "",
    "- **22 августа в 10:00**",
    "- номер записи: **1087113**",
    "",
    "[Свободное расписание УГМК](https://www.ugmk-clinic.ru/record/)",
  ].join("\n");
  const rich: string[] = [];
  const api = {
    async sendMessage() { return { message_id: 9 }; },
    async editMessageText() { return true; },
    async sendRichMessage(_chatId: number, value: string) {
      rich.push(value);
      return { message_id: 10 };
    },
    async editRichMessage() { return true; },
  };
  const message = new StreamingMessage(api, 1, 2, 1, "RichMarkdown");
  assert.equal(await message.finish(markdown), 10);
  assert.deepEqual(rich, [markdown]);
});

test("streaming agent text stays editable and becomes rich on completion", async () => {
  const plainEdits: string[] = [];
  const richEdits: string[] = [];
  const api = {
    async sendMessage() { return { message_id: 9 }; },
    async editMessageText(_chatId: number, _messageId: number, text: string) {
      plainEdits.push(text);
      return true;
    },
    async sendRichMessage() { return { message_id: 10 }; },
    async editRichMessage(_chatId: number, _messageId: number, markdown: string) {
      richEdits.push(markdown);
      return true;
    },
  };
  const message = new StreamingMessage(api, 1, 2, 10, "RichMarkdown");
  await message.start("Начало");
  message.update("Начало **жирного");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await message.finish("Начало **жирного текста**");
  assert.deepEqual(plainEdits, ["Начало **жирного"]);
  assert.deepEqual(richEdits, ["Начало **жирного текста**"]);
});

test("turn sink preserves rich formatting when an agent message starts with a delta", async () => {
  const plainSent: string[] = [];
  const plainEdits: string[] = [];
  const richSent: string[] = [];
  const richEdits: string[] = [];
  const telegram = {
    async sendMessage(_chatId: number, text: string) {
      plainSent.push(text);
      return { message_id: 20 };
    },
    async editMessageText(_chatId: number, _messageId: number, text: string) {
      plainEdits.push(text);
      return true;
    },
    async sendRichMessage(_chatId: number, markdown: string) {
      richSent.push(markdown);
      return { message_id: 21 };
    },
    async editRichMessage(_chatId: number, _messageId: number, markdown: string) {
      richEdits.push(markdown);
      return true;
    },
    async setMessageReaction() { return true as const; },
    async sendChatAction() { return true as const; },
  };
  const sink = new TelegramTurnSink(telegram, 1, 2, {
    streamUpdateIntervalMs: 1_000,
    completionReactionCustomEmojiId: null,
    inboundMessageId: 7,
  });
  sink.onNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      delta: "Начало **жирного",
    },
  });
  sink.onNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: agentItem("agent-1", "Начало **жирного текста**"),
      completedAtMs: 1,
    },
  });
  await sink.drain();

  assert.deepEqual(plainSent, ["Начало **жирного"]);
  assert.deepEqual(plainEdits, []);
  assert.deepEqual(richSent, []);
  assert.deepEqual(richEdits, ["Начало **жирного текста**"]);
});

test("rich message rejection falls back to lossless plain text", async () => {
  const plain: string[] = [];
  const api = {
    async sendMessage(_chatId: number, text: string) {
      plain.push(text);
      return { message_id: 9 };
    },
    async editMessageText() { return true; },
    async sendRichMessage() { throw new Error("unsupported rich message"); },
    async editRichMessage() { throw new Error("unsupported rich message"); },
  };
  const message = new StreamingMessage(api, 1, 2, 1, "RichMarkdown", false, nullLogger);
  assert.equal(await message.finish("Сохрани **исходную разметку**"), 9);
  assert.deepEqual(plain, ["Сохрани **исходную разметку**"]);
});

test("turn sink uses the configured custom completion reaction", async () => {
  const reactions: unknown[] = [];
  const telegram = {
    async sendMessage() { return { message_id: 50 }; },
    async editMessageText() { return true; },
    async sendRichMessage() { return { message_id: 50 }; },
    async editRichMessage() { return true; },
    async setMessageReaction(_chatId: number, _messageId: number, reaction: unknown) {
      reactions.push(reaction);
      return true as const;
    },
    async sendChatAction() { return true as const; },
  };
  const sink = new TelegramTurnSink(telegram, 1, 2, {
    streamUpdateIntervalMs: 1,
    completionReactionCustomEmojiId: "checkmark-custom-emoji-id",
    inboundMessageId: 7,
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

test("typing indicator refreshes while working and pauses while waiting for the user", async () => {
  const actions: Array<{ chatId: number; action: string; threadId?: number }> = [];
  const telegram = {
    async sendChatAction(chatId: number, action: "typing", threadId?: number) {
      actions.push({ chatId, action, ...(threadId === undefined ? {} : { threadId }) });
      return true as const;
    },
  };
  const indicator = new TypingIndicator(telegram, 1, 2, 10);
  indicator.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(actions.length >= 2);

  indicator.setWaitingForUser(true);
  const pausedAt = actions.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(actions.length, pausedAt);

  indicator.setWaitingForUser(false);
  assert.equal(actions.length, pausedAt + 1);
  indicator.stop();
  const stoppedAt = actions.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(actions.length, stoppedAt);
  assert.deepEqual(actions[0], { chatId: 1, action: "typing", threadId: 2 });
});
