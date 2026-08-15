import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ParakeetTranscriptionError,
  ParakeetVoiceTranscriber,
  type CommandRunner,
} from "../src/transcription/parakeet.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];

  constructor(private readonly transcript: string) {}

  async run(command: string, args: string[], timeoutMs: number) {
    this.calls.push({ command, args, timeoutMs });
    if (command === "/usr/bin/ffmpeg-test") {
      const destination = args.at(-1);
      if (!destination) throw new Error("missing ffmpeg destination");
      await writeFile(destination, "wav");
      return { stdout: "", stderr: "" };
    }
    return { stdout: this.transcript, stderr: "model diagnostics" };
  }
}

test("Parakeet V3 converts OGG/Opus to 16 kHz mono WAV and returns stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentger-parakeet-"));
  const source = join(root, "voice.ogg");
  const runner = new FakeRunner("  Распознанный текст.\n");
  await writeFile(source, "ogg");
  try {
    const transcriber = new ParakeetVoiceTranscriber({
      ffmpegBinary: "/usr/bin/ffmpeg-test",
      parakeetBinary: "/usr/local/bin/nemo-speech-test",
      parakeetModelPath: "/models/parakeet-tdt-0.6b-v3.q8_0.gguf",
      parakeetDevice: "cpu",
      timeoutMs: 123_000,
    }, runner);

    assert.equal(await transcriber.transcribe(source), "Распознанный текст.");
    assert.equal(runner.calls.length, 2);
    assert.deepEqual(runner.calls[0]?.args.slice(0, -1), [
      "-nostdin",
      "-v", "error",
      "-y",
      "-i", source,
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
    ]);
    const wavPath = runner.calls[0]?.args.at(-1);
    assert.match(wavPath ?? "", /\.parakeet-[0-9a-f-]+\.wav$/u);
    assert.deepEqual(runner.calls[1], {
      command: "/usr/local/bin/nemo-speech-test",
      args: [
        "transcribe",
        wavPath,
        "--model",
        "/models/parakeet-tdt-0.6b-v3.q8_0.gguf",
        "--device",
        "cpu",
      ],
      timeoutMs: 123_000,
    });
    await assert.rejects(stat(wavPath ?? ""), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty Parakeet V3 output is rejected and the temporary WAV is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentger-parakeet-"));
  const source = join(root, "voice.ogg");
  const runner = new FakeRunner(" \n");
  await writeFile(source, "ogg");
  try {
    const transcriber = new ParakeetVoiceTranscriber({
      ffmpegBinary: "/usr/bin/ffmpeg-test",
      parakeetBinary: "nemo-speech",
      parakeetModelPath: "/models/parakeet-tdt-0.6b-v3.q8_0.gguf",
      parakeetDevice: null,
      timeoutMs: 1_000,
    }, runner);
    await assert.rejects(
      transcriber.transcribe(source),
      (error: unknown) => error instanceof ParakeetTranscriptionError
        && /пустой транскрипт/u.test(error.message),
    );
    const wavPath = runner.calls[0]?.args.at(-1) ?? "";
    await assert.rejects(stat(wavPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
