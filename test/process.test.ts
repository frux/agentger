import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { AppServerSupervisor } from "../src/app-server/process.js";
import { nullLogger } from "../src/logger.js";

const fakeServer = String.raw`
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    if (initialized) process.exit(11);
    process.stdout.write(JSON.stringify({ id: msg.id, result: {
      userAgent: "fake/1", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux"
    } }) + "\n");
  } else if (msg.method === "initialized") {
    initialized = true;
  } else if (!initialized) {
    process.exit(12);
  } else if (msg.method === "hang") {
    setTimeout(() => process.exit(7), 20);
  } else {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\n");
  }
});
`;

test("supervisor handshakes, rejects on death, and reconnects", async () => {
  const supervisor = new AppServerSupervisor({
    logger: nullLogger,
    restartBaseMs: 10,
    restartMaxMs: 10,
    random: () => 0.5,
    versionResolver: () => "fake-codex 1.0",
    spawnProcess: () => spawn(process.execPath, ["--input-type=module", "-e", fakeServer], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
  });
  await supervisor.start();
  assert.equal(supervisor.health.ready, true);
  assert.equal(supervisor.generation, 1);
  assert.deepEqual(await supervisor.request("echo"), { ok: true });
  const restarted = once(supervisor, "ready");
  await assert.rejects(supervisor.request("hang", undefined, 1_000), /exited/u);
  assert.equal(supervisor.health.ready, false);
  assert.equal((await restarted)[0], 2);
  assert.deepEqual(await supervisor.request("echo"), { ok: true });
  await supervisor.stop();
});
