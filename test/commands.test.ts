import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeDatabase } from "../src/db.js";
import { TelegramCommands } from "../src/telegram/commands.js";
import { TopicRouter } from "../src/telegram/router.js";

test("/esc interrupts the active turn in the current topic", async () => {
  const db = new BridgeDatabase(":memory:");
  db.createBinding({
    telegramChatId: -1001,
    telegramThreadId: 12,
    codexThreadId: "thread-12",
    workingDirectory: "/projects/agentger",
    title: null,
  });
  const interrupted: string[] = [];
  const sent: Array<{ chatId: number; text: string; options: unknown }> = [];
  const commands = new TelegramCommands(
    {
      async sendMessage(chatId: number, text: string, options: unknown) {
        sent.push({ chatId, text, options });
        return { message_id: 100 };
      },
    } as never,
    db,
    {} as never,
    new TopicRouter(db),
    {} as never,
    {
      async interrupt(threadId: string) {
        interrupted.push(threadId);
        return true;
      },
    } as never,
  );

  const handled = await commands.handle({
    message_id: 50,
    message_thread_id: 12,
    chat: { id: -1001, type: "supergroup" },
    from: { id: 42 },
    text: "/esc@agentger_bot",
  });

  assert.equal(handled, true);
  assert.deepEqual(interrupted, ["thread-12"]);
  assert.deepEqual(sent, [{
    chatId: -1001,
    text: "⏹ Запрос на остановку turn отправлен.",
    options: { messageThreadId: 12 },
  }]);
  db.close();
});
