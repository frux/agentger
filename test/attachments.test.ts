import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelegramFileDownloader } from "../src/telegram/attachments.js";
import { TelegramAttachmentManager } from "../src/telegram/attachments.js";
import type { TelegramFile, TelegramMessage } from "../src/telegram/api.js";
import type { VoiceTranscriber } from "../src/transcription/parakeet.js";
import { AppServerClient } from "../src/app-server/client.js";

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

class FakeVoiceTranscriber implements VoiceTranscriber {
  paths: string[] = [];

  constructor(private readonly transcript = "Это расшифрованное голосовое сообщение.") {}

  async transcribe(path: string): Promise<string> {
    this.paths.push(path);
    return this.transcript;
  }
}

function attachmentManager(
  downloader: TelegramFileDownloader,
  root: string,
  maxBytes: number,
  transcriber: VoiceTranscriber = new FakeVoiceTranscriber(),
): TelegramAttachmentManager {
  return new TelegramAttachmentManager(downloader, root, maxBytes, transcriber);
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
    const manager = attachmentManager(downloader, root, 20 * 1024 * 1024);
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
    const manager = attachmentManager(downloader, root, 1_000);
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

test("Telegram voice is transcribed before Codex receives the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentger-attachments-"));
  const downloader = new FakeDownloader();
  const transcriber = new FakeVoiceTranscriber("Проверь, пожалуйста, статус сервиса.");
  try {
    const manager = attachmentManager(downloader, root, 100, transcriber);
    const voice = await manager.prepare(message({
      voice: { file_id: "voice", file_unique_id: "voice-id", duration: 3, file_size: 4, mime_type: "audio/ogg" },
    }));
    assert.deepEqual(voice, [{
      type: "text",
      text: "Проверь, пожалуйста, статус сервиса.",
      text_elements: [],
    }]);
    assert.equal(transcriber.paths.length, 1);
    assert.match(transcriber.paths[0] ?? "", /voice-voice-id\.ogg$/u);

    const requests: Array<{ method: string; params: unknown }> = [];
    const client = new AppServerClient({
      request(method: string, params: unknown) {
        requests.push({ method, params });
        return Promise.resolve({ turn: { id: "turn-voice" } });
      },
    } as never);
    await client.startTurn("thread-voice", voice, "tg:-1001:42:77");
    assert.deepEqual(requests, [{
      method: "turn/start",
      params: {
        threadId: "thread-voice",
        input: [{
          type: "text",
          text: "Проверь, пожалуйста, статус сервиса.",
          text_elements: [],
        }],
        clientUserMessageId: "tg:-1001:42:77",
      },
    }]);

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
    const manager = attachmentManager(downloader, root, 100);
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
