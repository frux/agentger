import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelegramFileDownloader } from "../src/telegram/attachments.js";
import { TelegramAttachmentManager } from "../src/telegram/attachments.js";
import type { TelegramFile, TelegramMessage } from "../src/telegram/api.js";

class FakeDownloader implements TelegramFileDownloader {
  requested: string[] = [];
  downloaded: Array<{ remote: string; destination: string; maxBytes: number }> = [];

  async getFile(fileId: string): Promise<TelegramFile> {
    this.requested.push(fileId);
    return {
      file_id: fileId,
      file_unique_id: `unique-${fileId}`,
      file_size: 4,
      file_path: fileId === "voice" ? "voice/file.oga" : `telegram/${fileId}.bin`,
    };
  }

  async downloadFile(remote: string, destination: string, maxBytes: number): Promise<number> {
    this.downloaded.push({ remote, destination, maxBytes });
    await writeFile(destination, "data", { mode: 0o600 });
    return 4;
  }
}

function message(overrides: Partial<TelegramMessage>): TelegramMessage {
  return {
    message_id: 77,
    message_thread_id: 42,
    chat: { id: -1001, type: "supergroup" },
    from: { id: 5 },
    ...overrides,
  };
}

test("photo captions and the largest photo become one multimodal turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentger-attachments-"));
  const downloader = new FakeDownloader();
  try {
    const manager = new TelegramAttachmentManager(downloader, root, 20 * 1024 * 1024);
    const input = await manager.prepare(message({
      caption: "Что изображено?",
      photo: [
        { file_id: "small", file_unique_id: "s", width: 90, height: 90, file_size: 100 },
        { file_id: "large", file_unique_id: "l", width: 1280, height: 720, file_size: 1_000 },
      ],
    }));
    assert.deepEqual(downloader.requested, ["large"]);
    assert.deepEqual(input[0], { type: "text", text: "Что изображено?", text_elements: [] });
    assert.equal(input[1]?.type, "localImage");
    if (input[1]?.type !== "localImage") throw new Error("localImage input expected");
    assert.equal(await readFile(input[1].path, "utf8"), "data");
    assert.equal((await stat(input[1].path)).mode & 0o777, 0o600);
    await manager.prepare(message({
      caption: "Что изображено?",
      photo: [{ file_id: "large", file_unique_id: "l", width: 1280, height: 720, file_size: 1_000 }],
    }));
    assert.equal(downloader.downloaded.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("arbitrary documents get a sanitized local mention and metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentger-attachments-"));
  const downloader = new FakeDownloader();
  try {
    const manager = new TelegramAttachmentManager(downloader, root, 1_000);
    const input = await manager.prepare(message({
      document: {
        file_id: "report",
        file_unique_id: "unique-report",
        file_name: "../../квартальный отчёт.csv",
        mime_type: "text/csv",
        file_size: 4,
      },
    }));
    assert.equal(input[0]?.type, "text");
    if (input[0]?.type !== "text") throw new Error("document metadata expected");
    assert.match(input[0].text, /Путь: .*квартальный_отчёт\.csv/u);
    assert.match(input[0].text, /MIME-тип: text\/csv/u);
    assert.equal(input[1]?.type, "mention");
    if (input[1]?.type !== "mention") throw new Error("mention input expected");
    assert.equal(input[1].name, "квартальный_отчёт.csv");
    assert.ok(input[1].path.startsWith(await realpath(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("voice messages become localAudio and oversized files fail before getFile", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentger-attachments-"));
  const downloader = new FakeDownloader();
  try {
    const manager = new TelegramAttachmentManager(downloader, root, 100);
    const voice = await manager.prepare(message({
      voice: { file_id: "voice", file_unique_id: "voice-id", duration: 3, file_size: 4, mime_type: "audio/ogg" },
    }));
    assert.equal(voice[0]?.type, "localAudio");
    if (voice[0]?.type !== "localAudio") throw new Error("localAudio input expected");
    assert.match(voice[0].path, /voice-voice-id\.ogg$/u);
    assert.doesNotMatch(voice[0].path, /\.oga$/u);
    await assert.rejects(
      manager.prepare(message({
        document: { file_id: "huge", file_unique_id: "huge-id", file_size: 101 },
      })),
      /превышает лимит/u,
    );
    assert.deepEqual(downloader.requested, ["voice"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio documents also normalize their .oga filename to .ogg", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentger-attachments-"));
  const downloader = new FakeDownloader();
  try {
    const manager = new TelegramAttachmentManager(downloader, root, 100);
    const audio = await manager.prepare(message({
      document: {
        file_id: "audio-document",
        file_unique_id: "audio-document-id",
        file_name: "recording.oga",
        mime_type: "audio/ogg",
        file_size: 4,
      },
    }));
    assert.equal(audio[0]?.type, "localAudio");
    if (audio[0]?.type !== "localAudio") throw new Error("localAudio input expected");
    assert.match(audio[0].path, /recording\.ogg$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
