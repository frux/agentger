import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeDatabase } from "../src/db.js";
import { ProjectPathDeniedError, ProjectResolver } from "../src/projects.js";
import { TopicRouter } from "../src/telegram/router.js";

test("router isolates unknown, reserved, and registered topics", () => {
  const db = new BridgeDatabase(":memory:");
  const router = new TopicRouter(db);
  assert.deepEqual(router.route(1, 50), { type: "unknown" });
  db.reserveTopic(1, 10, "daily report");
  assert.deepEqual(router.route(1, 10), { type: "reserved", purpose: "daily report" });
  db.createBinding({
    telegramChatId: 1,
    telegramThreadId: 30,
    codexThreadId: "thread-a",
    workingDirectory: "/projects/a",
    title: null,
  });
  const route = router.route(1, 30);
  assert.equal(route.type, "codex");
  if (route.type === "codex") assert.equal(route.binding.codexThreadId, "thread-a");
  assert.deepEqual(router.route(1, undefined), { type: "not-topic" });
  db.close();
});

test("project resolver accepts canonical children and blocks symlink traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "telecodex-root-"));
  const outside = await mkdtemp(join(tmpdir(), "telecodex-outside-"));
  try {
    const project = join(root, "project");
    await mkdir(project);
    const link = join(root, "escape");
    await symlink(outside, link);
    const db = new BridgeDatabase(":memory:");
    db.upsertProject("ok", project);
    db.upsertProject("escape", link);
    const resolver = new ProjectResolver(db, [root]);
    assert.equal(await resolver.resolveAlias("ok"), await realpath(project));
    await assert.rejects(resolver.resolveAlias("escape"), ProjectPathDeniedError);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
