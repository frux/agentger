import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import packageJson from "../package.json" with { type: "json" };

const cli = resolve(process.cwd(), "dist/src/cli.js");

test("package exposes the agentger global executable", () => {
  assert.deepEqual(packageJson.bin, { agentger: "./dist/src/cli.js" });
  assert.equal(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim(), packageJson.version);
  assert.match(execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }), /agentger init/u);
});

test("agentger init creates a usable config template without overwriting", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agentger-cli-"));
  try {
    execFileSync(process.execPath, [cli, "init"], { cwd, encoding: "utf8" });
    assert.match(await readFile(join(cwd, ".env"), "utf8"), /DEFAULT_PROJECT=frux/u);
    assert.throws(() => execFileSync(process.execPath, [cli, "init"], { cwd, encoding: "utf8", stdio: "pipe" }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
