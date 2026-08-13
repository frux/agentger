import assert from "node:assert/strict";
import { test } from "node:test";
import { AppServerClient } from "../src/app-server/client.js";
import { AppServerSupervisor } from "../src/app-server/process.js";
import type { ServerNotification } from "../src/app-server/generated/ServerNotification.js";
import { logger } from "../src/logger.js";

const enabled = process.env.AGENTGER_INTEGRATION === "1";

test("app-server opt-in lifecycle", { skip: !enabled, timeout: 120_000 }, async () => {
  const client = new AppServerClient(new AppServerSupervisor({ logger }), {
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  client.setServerRequestHandler(async (request) => {
    throw new Error(`Unexpected server request: ${request.method}`);
  });
  const notifications: ServerNotification[] = [];
  client.onNotification((notification) => notifications.push(notification));
  await client.start();
  try {
    const started = await client.startThread(process.cwd());
    const turn = await client.startTurn(started.thread.id, "Reply with exactly: agentger integration ok", "integration-test-1");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("turn/completed timeout")), 90_000);
      const off = client.onNotification((notification) => {
        if (notification.method === "turn/completed" && notification.params.turn.id === turn.turn.id) {
          clearTimeout(timeout);
          off();
          notification.params.turn.status === "completed" ? resolve() : reject(new Error(`turn status ${notification.params.turn.status}`));
        }
      });
    });
    assert.ok(notifications.some((notification) => notification.method === "turn/started"));
    assert.ok(notifications.some((notification) => notification.method === "item/agentMessage/delta"));
    const history = await client.readThread(started.thread.id, true);
    assert.ok(history.thread.turns.some((item) => item.id === turn.turn.id));
  } finally {
    await client.stop();
  }
});
