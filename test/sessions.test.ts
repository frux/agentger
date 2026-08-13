import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ServerNotification } from "../src/app-server/generated/ServerNotification.js";
import { BridgeDatabase, type TopicBinding } from "../src/db.js";
import { SessionManager, type SessionClient, type TurnSink } from "../src/sessions/manager.js";

class FakeSessionClient extends EventEmitter implements SessionClient {
  generation = 1;
  starts: Array<{ threadId: string; text: string }> = [];
  interrupts: Array<{ threadId: string; turnId: string }> = [];

  onNotification(listener: (notification: ServerNotification) => void): () => void {
    this.on("notification", listener);
    return () => this.off("notification", listener);
  }
  onReady(listener: (generation: number) => void): () => void {
    this.on("ready", listener);
    return () => this.off("ready", listener);
  }
  onDown(listener: (error: Error) => void): () => void {
    this.on("down", listener);
    return () => this.off("down", listener);
  }
  async resumeThread(threadId: string) {
    return { model: "test-model", thread: { id: threadId, status: { type: "idle" } } } as never;
  }
  async startTurn(threadId: string, text: string) {
    this.starts.push({ threadId, text });
    return { turn: { id: `turn-${this.starts.length}` } } as never;
  }
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId });
  }
  async readThread() {
    return { thread: { turns: [] } } as never;
  }
  complete(threadId: string, turnId: string): void {
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: turnId, items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1_000 },
      },
    } satisfies ServerNotification);
  }
}

const sink: TurnSink = { onNotification() {}, onError() {} };

function binding(threadId = "thread-a"): TopicBinding {
  return {
    telegramChatId: 1,
    telegramThreadId: 30,
    codexThreadId: threadId,
    workingDirectory: "/project",
    title: null,
    createdAt: "now",
    brokenReason: null,
  };
}

function persistedBinding(db: BridgeDatabase, threadId = "thread-a"): TopicBinding {
  return db.createBinding({
    telegramChatId: 1,
    telegramThreadId: 30,
    codexThreadId: threadId,
    workingDirectory: "/project",
    title: null,
  });
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
}

test("turns are serialized per Codex thread", async () => {
  const client = new FakeSessionClient();
  const db = new BridgeDatabase(":memory:");
  const sessions = new SessionManager(client, db);
  const topic = persistedBinding(db);
  const first = sessions.enqueue(topic, "first", "tg-1", sink);
  const second = sessions.enqueue(topic, "second", "tg-2", sink);
  await until(() => client.starts.length === 1);
  assert.deepEqual(client.starts, [{ threadId: "thread-a", text: "first" }]);
  client.complete("thread-a", "turn-1");
  await first;
  await until(() => client.starts.length === 2);
  assert.deepEqual(client.starts[1], { threadId: "thread-a", text: "second" });
  client.complete("thread-a", "turn-2");
  await second;
  db.close();
});

test("interrupt targets only the active turn", async () => {
  const client = new FakeSessionClient();
  const db = new BridgeDatabase(":memory:");
  const sessions = new SessionManager(client, db);
  const running = sessions.enqueue(persistedBinding(db), "work", "tg-1", sink);
  await until(() => client.starts.length === 1);
  assert.equal(await sessions.interrupt("thread-a"), true);
  assert.deepEqual(client.interrupts, [{ threadId: "thread-a", turnId: "turn-1" }]);
  client.complete("thread-a", "turn-1");
  await running;
  assert.equal(await sessions.interrupt("thread-a"), false);
  db.close();
});

test("turn sink lifecycle marks processing, accepted input, and approval waits", async () => {
  const client = new FakeSessionClient();
  const db = new BridgeDatabase(":memory:");
  const sessions = new SessionManager(client, db);
  const lifecycle: string[] = [];
  const lifecycleSink: TurnSink = {
    onProcessingStarted() { lifecycle.push("processing"); },
    onInputAccepted() { lifecycle.push("accepted"); },
    setWaitingForUser(waiting) { lifecycle.push(waiting ? "waiting" : "resumed"); },
    onNotification() {},
    onError() {},
  };
  const running = sessions.enqueue(persistedBinding(db), "work", "tg-1", lifecycleSink);
  await until(() => client.starts.length === 1);
  assert.deepEqual(lifecycle, ["processing", "accepted"]);
  sessions.setWaitingApproval("thread-a", true);
  sessions.setWaitingApproval("thread-a", false);
  assert.deepEqual(lifecycle, ["processing", "accepted", "waiting", "resumed"]);
  client.complete("thread-a", "turn-1");
  await running;
  db.close();
});
