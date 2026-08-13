import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nullLogger } from "../src/logger.js";
import { TelegramApi } from "../src/telegram/api.js";

test("Telegram API sends completion reactions with the Bot API shape", async () => {
  let requestUrl = "";
  let requestBody: unknown;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const api = new TelegramApi("test-token", nullLogger, fetchImpl);
  assert.equal(await api.setMessageReaction(10, 20, { type: "emoji", emoji: "👍" }), true);
  assert.match(requestUrl, /\/setMessageReaction$/u);
  assert.deepEqual(requestBody, {
    chat_id: 10,
    message_id: 20,
    reaction: [{ type: "emoji", emoji: "👍" }],
  });
});

test("Telegram API sends topic-scoped typing actions", async () => {
  let requestUrl = "";
  let requestBody: unknown;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  };
  const api = new TelegramApi("test-token", nullLogger, fetchImpl);
  assert.equal(await api.sendChatAction(-1001, "typing", 42), true);
  assert.match(requestUrl, /\/sendChatAction$/u);
  assert.deepEqual(requestBody, {
    chat_id: -1001,
    action: "typing",
    message_thread_id: 42,
  });
});

test("Telegram API resolves and streams files to a private local path", async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/getFile")) {
      return new Response(JSON.stringify({
        ok: true,
        result: { file_id: "voice-id", file_unique_id: "unique", file_size: 4, file_path: "voice/file.ogg" },
      }), { status: 200 });
    }
    return new Response("opus", { status: 200, headers: { "content-length": "4" } });
  };
  const root = await mkdtemp(join(tmpdir(), "agentger-api-"));
  try {
    const destination = join(root, "voice.ogg");
    const api = new TelegramApi("test-token", nullLogger, fetchImpl);
    const remote = await api.getFile("voice-id");
    assert.equal(remote.file_path, "voice/file.ogg");
    assert.equal(await api.downloadFile(remote.file_path ?? "", destination, 10), 4);
    assert.equal(await readFile(destination, "utf8"), "opus");
    assert.match(urls[1] ?? "", /\/file\/bottest-token\/voice\/file\.ogg$/u);
    await assert.rejects(api.downloadFile("../secret", join(root, "bad"), 10), /invalid file path/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram API aborts an oversized stream and removes its partial file", async () => {
  const fetchImpl: typeof fetch = async () => new Response("too large", { status: 200 });
  const root = await mkdtemp(join(tmpdir(), "agentger-api-limit-"));
  try {
    const destination = join(root, "oversized.bin");
    const api = new TelegramApi("test-token", nullLogger, fetchImpl);
    await assert.rejects(api.downloadFile("documents/file.bin", destination, 4), /download limit/u);
    await assert.rejects(access(destination), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
