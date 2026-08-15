import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import type { UserInput } from "../app-server/generated/v2/UserInput.js";
import type {
  TelegramAudio,
  TelegramDocument,
  TelegramFile,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramVoice,
} from "./api.js";
import { TelegramFileTooLargeError } from "./api.js";

export interface TelegramFileDownloader {
  getFile(fileId: string): Promise<TelegramFile>;
  downloadFile(filePath: string, destination: string, maxBytes: number): Promise<number>;
}

type DownloadableMedia = TelegramPhotoSize | TelegramDocument | TelegramAudio | TelegramVoice;
type MediaKind = "photo" | "document" | "audio" | "voice";

export class TelegramAttachmentError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TelegramAttachmentError";
  }
}

export class TelegramAttachmentManager {
  private readonly root: string;

  constructor(
    private readonly telegram: TelegramFileDownloader,
    attachmentDirectory: string,
    private readonly maxBytes: number,
  ) {
    this.root = resolve(attachmentDirectory);
  }

  async prepare(message: TelegramMessage): Promise<UserInput[]> {
    const input: UserInput[] = [];
    const text = (message.text ?? message.caption)?.trim();
    if (text) input.push(textInput(text));

    const photo = largestPhoto(message.photo);
    if (photo) {
      const path = await this.download(message, "photo", photo);
      input.push({ type: "localImage", path });
    }
    if (message.document) {
      const audioDocument = isAudio(message.document);
      const path = await this.download(message, audioDocument ? "audio" : "document", message.document);
      if (isImage(message.document)) {
        input.push({ type: "localImage", path });
      } else if (audioDocument) {
        input.push({ type: "localAudio", path });
      } else {
        const name = cleanFileName(message.document.file_name) ?? basename(path);
        input.push(textInput(documentDescription(path, name, message.document)));
        input.push({ type: "mention", name, path });
      }
    }
    if (message.audio) {
      input.push({ type: "localAudio", path: await this.download(message, "audio", message.audio) });
    }
    if (message.voice) {
      input.push({ type: "localAudio", path: await this.download(message, "voice", message.voice) });
    }
    return input;
  }

  private async download(message: TelegramMessage, kind: MediaKind, media: DownloadableMedia): Promise<string> {
    this.assertSize(media.file_size);
    let remote: TelegramFile;
    try {
      remote = await this.telegram.getFile(media.file_id);
    } catch (error) {
      throw new TelegramAttachmentError("Telegram не вернул данные вложения", error);
    }
    this.assertSize(remote.file_size);
    if (!remote.file_path) throw new TelegramAttachmentError("Telegram не вернул путь к вложению");

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(this.root);
    const directory = await ensureDirectoryTree(
      canonicalRoot,
      [
        String(message.chat.id),
        String(message.message_thread_id ?? 0),
        String(message.message_id),
      ],
    );
    if (!directory.startsWith(`${canonicalRoot}${sep}`)) {
      throw new TelegramAttachmentError("Каталог вложения выходит за пределы ATTACHMENT_DIRECTORY");
    }
    const destination = resolve(directory, destinationName(kind, media, remote.file_path));
    if (!destination.startsWith(`${directory}${sep}`)) {
      throw new TelegramAttachmentError("Не удалось подготовить безопасное имя вложения");
    }
    const existing = await lstat(destination).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    });
    const expectedSize = remote.file_size ?? media.file_size;
    if (existing) {
      if (existing.isFile() && !existing.isSymbolicLink() && existing.size <= this.maxBytes
        && (expectedSize === undefined || existing.size === expectedSize)) {
        return destination;
      }
      throw new TelegramAttachmentError("Локальный путь вложения уже занят неожиданным файлом");
    }

    const temporary = `${destination}.part-${randomUUID()}`;
    try {
      await this.telegram.downloadFile(remote.file_path, temporary, this.maxBytes);
      await rename(temporary, destination);
      return destination;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (error instanceof TelegramFileTooLargeError) this.assertSize(error.actualBytes ?? this.maxBytes + 1);
      throw new TelegramAttachmentError("Не удалось скачать вложение из Telegram", error);
    }
  }

  private assertSize(size: number | undefined): void {
    if (size !== undefined && size > this.maxBytes) {
      throw new TelegramAttachmentError(`Вложение превышает лимит ${formatBytes(this.maxBytes)}`);
    }
  }
}

function textInput(text: string): UserInput {
  return { type: "text", text, text_elements: [] };
}

function largestPhoto(photos: TelegramPhotoSize[] | undefined): TelegramPhotoSize | undefined {
  return photos?.reduce<TelegramPhotoSize | undefined>((largest, photo) => {
    if (!largest) return photo;
    const area = photo.width * photo.height;
    const largestArea = largest.width * largest.height;
    if (area !== largestArea) return area > largestArea ? photo : largest;
    return (photo.file_size ?? 0) > (largest.file_size ?? 0) ? photo : largest;
  }, undefined);
}

function isImage(document: TelegramDocument): boolean {
  return document.mime_type?.startsWith("image/") === true
    || /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(document.file_name ?? "");
}

function isAudio(document: TelegramDocument): boolean {
  return document.mime_type?.startsWith("audio/") === true
    || /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav)$/iu.test(document.file_name ?? "");
}

function documentDescription(path: string, name: string, document: TelegramDocument): string {
  return [
    "Пользователь прикрепил файл, доступный локально.",
    `Путь: ${path}`,
    `Имя: ${name}`,
    ...(document.mime_type ? [`MIME-тип: ${document.mime_type}`] : []),
    ...(document.file_size === undefined ? [] : [`Размер: ${document.file_size} байт`]),
    "Учитывай этот файл как часть сообщения пользователя.",
  ].join("\n");
}

function destinationName(kind: MediaKind, media: DownloadableMedia, remotePath: string): string {
  const named = "file_name" in media ? cleanFileName(media.file_name) : null;
  if (named) return normalizeAudioExtension(kind, named);
  const remoteExtension = safeExtension(remotePath);
  const id = cleanSegment(media.file_unique_id).slice(0, 64) || "file";
  return normalizeAudioExtension(kind, `${kind}-${id}${remoteExtension}`);
}

function normalizeAudioExtension(kind: MediaKind, name: string): string {
  return (kind === "voice" || kind === "audio") && /\.oga$/iu.test(name)
    ? `${name.slice(0, -4)}.ogg`
    : name;
}

function cleanFileName(value: string | undefined): string | null {
  if (!value) return null;
  const raw = basename(value).normalize("NFKC");
  const cleaned = raw.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+/u, "").slice(0, 160);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : null;
}

function cleanSegment(value: string): string {
  return value.normalize("NFKC").replace(/[^A-Za-z0-9_-]+/gu, "_");
}

function safeExtension(value: string): string {
  const extension = extname(basename(value)).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : "";
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024
    ? `${Math.floor(value / (1024 * 1024))} МБ`
    : `${value} байт`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function ensureDirectoryTree(root: string, segments: string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TelegramAttachmentError("Каталог вложения содержит небезопасную ссылку");
    }
  }
  return current;
}
