import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeDatabase } from "../src/db.js";
import type { TelegramMessage } from "../src/telegram/api.js";
import { TopicRouter } from "../src/telegram/router.js";
import { TopicProvisioner } from "../src/telegram/topics.js";

function message(threadId: number, created = false): TelegramMessage {
  return {
    message_id: threadId,
    message_thread_id: threadId,
    chat: { id: -1001, type: "supergroup" },
    from: { id: 42 },
    ...(created ? { forum_topic_created: { name: "New agent", icon_color: 0x6fb9f0 } } : { text: "hello" }),
  };
}

function setup() {
  const db = new BridgeDatabase(":memory:");
  const starts: string[] = [];
  const registrations: Array<{ threadId: string; model: string }> = [];
  const sent: string[] = [];
  const topics = new TopicProvisioner(
    { async sendMessage(_chatId, text) { sent.push(text); } },
    db,
    { async resolveDefault(name) { assert.equal(name, "frux"); return "/projects/frux"; } },
    new TopicRouter(db),
    {
      async startThread(cwd) {
        starts.push(cwd);
        return { thread: { id: `codex-${starts.length}` }, model: "gpt-test" } as never;
      },
      async unsubscribeThread() {},
    },
    { registerLoaded(threadId, model) { registrations.push({ threadId, model }); } },
    "frux",
  );
  return { db, starts, registrations, sent, topics };
}

test("forum_topic_created immediately provisions a Codex binding", async () => {
  const { db, starts, registrations, sent, topics } = setup();
  const binding = await topics.ensure(message(30, true), true);
  assert.equal(binding?.codexThreadId, "codex-1");
  assert.equal(binding?.title, "New agent");
  assert.deepEqual(starts, ["/projects/frux"]);
  assert.deepEqual(registrations, [{ threadId: "codex-1", model: "gpt-test" }]);
  assert.match(sent[0] ?? "", /Создана новая сессия/u);
  db.close();
});

test("first message provisions an unknown existing topic without a separate announcement", async () => {
  const { db, starts, sent, topics } = setup();
  const first = await topics.ensure(message(40), false);
  const second = await topics.ensure(message(40), false);
  assert.equal(first?.codexThreadId, second?.codexThreadId);
  assert.equal(starts.length, 1);
  assert.deepEqual(sent, []);
  db.close();
});

test("reserved topics never provision Codex", async () => {
  const { db, starts, sent, topics } = setup();
  db.reserveTopic(-1001, 10, "daily report");
  assert.equal(await topics.ensure(message(10, true), true), null);
  assert.deepEqual(starts, []);
  assert.deepEqual(sent, []);
  db.close();
});
