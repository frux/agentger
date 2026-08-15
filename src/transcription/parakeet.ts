import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export interface VoiceTranscriber {
  transcribe(path: string): Promise<string>;
}

export interface ParakeetTranscriberOptions {
  ffmpegBinary: string;
  parakeetBinary: string;
  parakeetModelPath: string;
  parakeetDevice: string | null;
  timeoutMs: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult>;
}

export class ParakeetTranscriptionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ParakeetTranscriptionError";
  }
}

export class ExecFileCommandRunner implements CommandRunner {
  async run(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return await new Promise((resolve, reject) => {
      execFile(command, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

export class ParakeetVoiceTranscriber implements VoiceTranscriber {
  constructor(
    private readonly options: ParakeetTranscriberOptions,
    private readonly runner: CommandRunner = new ExecFileCommandRunner(),
  ) {}

  async transcribe(path: string): Promise<string> {
    const wavPath = `${path}.parakeet-${randomUUID()}.wav`;
    try {
      try {
        await this.runner.run(this.options.ffmpegBinary, [
          "-nostdin",
          "-v", "error",
          "-y",
          "-i", path,
          "-ac", "1",
          "-ar", "16000",
          "-c:a", "pcm_s16le",
          wavPath,
        ], this.options.timeoutMs);
        await chmod(wavPath, 0o600);
      } catch (error) {
        throw new ParakeetTranscriptionError(
          "Не удалось декодировать голосовое сообщение в WAV; проверьте FFMPEG_BINARY",
          error,
        );
      }

      let result: CommandResult;
      try {
        const args = [
          "transcribe",
          wavPath,
          "--model",
          this.options.parakeetModelPath,
        ];
        if (this.options.parakeetDevice) args.push("--device", this.options.parakeetDevice);
        result = await this.runner.run(this.options.parakeetBinary, args, this.options.timeoutMs);
      } catch (error) {
        throw new ParakeetTranscriptionError(
          "Не удалось распознать голосовое сообщение с Parakeet V3; запустите agentger doctor",
          error,
        );
      }

      const transcript = result.stdout.trim();
      if (!transcript) {
        throw new ParakeetTranscriptionError("Parakeet V3 вернул пустой транскрипт");
      }
      return transcript;
    } finally {
      await unlink(wavPath).catch(() => undefined);
    }
  }
}
