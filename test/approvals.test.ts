import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerRequest } from "../src/app-server/generated/ServerRequest.js";
import { BridgeDatabase } from "../src/db.js";
import { ApprovalManager, type ApprovalTelegram } from "../src/telegram/approvals.js";
import type { TelegramCallbackQuery } from "../src/telegram/api.js";

class FakeTelegram implements ApprovalTelegram {
  sent: Array<{ chatId: number; text: string; options: Parameters<ApprovalTelegram["sendMessage"]>[2] }> = [];
  edits: string[] = [];
  answers: string[] = [];
  async sendMessage(chatId: number, text: string, options: Parameters<ApprovalTelegram["sendMessage"]>[2]) {
    this.sent.push({ chatId, text, options });
    return { message_id: 99 };
  }
  async editMessageText(_chatId: number, _messageId: number, text: string) { this.edits.push(text); }
  async answerCallbackQuery(_id: string, text?: string) { this.answers.push(text ?? ""); }
}

function setup() {
  const db = new BridgeDatabase(":memory:");
  db.createBinding({
    telegramChatId: 1,
    telegramThreadId: 30,
    codexThreadId: "thread-a",
    workingDirectory: "/project",
    title: null,
  });
  const telegram = new FakeTelegram();
  const waiting: boolean[] = [];
  const approvals = new ApprovalManager(
    telegram,
    db,
    { setWaitingApproval: (_threadId, value) => waiting.push(value) },
    new Set([42]),
    60_000,
  );
  return { db, telegram, waiting, approvals };
}

function request(): ServerRequest {
  return {
    method: "item/commandExecution/requestApproval",
    id: 7,
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "item-a",
      startedAtMs: Date.now(),
      environmentId: null,
      reason: "install dependency",
      command: "npm install foo",
      cwd: "/project",
    },
  };
}

function callback(data: string, id = "callback-1"): TelegramCallbackQuery {
  return {
    id,
    from: { id: 42 },
    data,
    message: { message_id: 99, chat: { id: 1, type: "supergroup" }, message_thread_id: 30 },
  };
}

async function approvalData(telegram: FakeTelegram): Promise<string> {
  for (let attempt = 0; attempt < 20 && telegram.sent.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const data = telegram.sent[0]?.options.replyMarkup.inline_keyboard[0]?.[0]?.callback_data;
  if (!data) throw new Error("missing approval callback");
  return data;
}

test("approval allow returns accept and duplicate callback is idempotent", async () => {
  const { db, telegram, waiting, approvals } = setup();
  const result = approvals.handleServerRequest(request());
  const data = await approvalData(telegram);
  assert.equal(await approvals.handleCallback(callback(data)), true);
  assert.deepEqual(await result, { decision: "accept" });
  assert.deepEqual(waiting, [true, false]);
  assert.equal(approvals.size, 0);
  assert.equal(await approvals.handleCallback(callback(data, "callback-2")), true);
  assert.equal(telegram.answers.at(-1), "Решение уже принято");
  db.close();
});

test("approval deny returns decline", async () => {
  const { db, telegram, approvals } = setup();
  const result = approvals.handleServerRequest(request());
  const allowData = await approvalData(telegram);
  const denyData = allowData.replace(/:a$/u, ":d");
  await approvals.handleCallback(callback(denyData));
  assert.deepEqual(await result, { decision: "decline" });
  assert.match(telegram.edits.at(-1) ?? "", /Отклонено/u);
  db.close();
});
