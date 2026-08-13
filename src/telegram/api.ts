import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

export interface TelegramUser {
  id: number;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio extends TelegramDocument {
  duration: number;
  performer?: string;
  title?: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  media_group_id?: string;
  forum_topic_created?: {
    name: string;
    icon_color: number;
    icon_custom_emoji_id?: string;
  };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageOptions {
  messageThreadId?: number;
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
  parseMode?: "MarkdownV2";
}

export type TelegramReaction =
  | { type: "emoji"; emoji: "👍" | "👀" }
  | { type: "custom_emoji"; custom_emoji_id: string };

type TelegramEnvelope<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export class TelegramApi {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;

  constructor(
    token: string,
    private readonly log: Logger = defaultLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!token) throw new Error("Telegram bot token is required");
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    }, signal, 1);
  }

  sendMessage(chatId: number, text: string, options: SendMessageOptions = {}): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(options.messageThreadId === undefined ? {} : { message_thread_id: options.messageThreadId }),
      ...(options.replyMarkup === undefined ? {} : { reply_markup: options.replyMarkup }),
      ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
      disable_web_page_preview: true,
    });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: SendMessageOptions["replyMarkup"],
    parseMode?: SendMessageOptions["parseMode"],
  ): Promise<TelegramMessage | true> {
    return this.call<TelegramMessage | true>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
      ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
      disable_web_page_preview: true,
    }).catch((error: unknown) => {
      if (error instanceof TelegramApiError && error.message.includes("message is not modified")) return true;
      throw error;
    });
  }

  setMessageReaction(chatId: number, messageId: number, reaction: TelegramReaction): Promise<true> {
    return this.call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [reaction],
    });
  }

  sendChatAction(chatId: number, action: "typing", messageThreadId?: number): Promise<true> {
    return this.call("sendChatAction", {
      chat_id: chatId,
      action,
      ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<true> {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text === undefined ? {} : { text }),
    });
  }

  getFile(fileId: string): Promise<TelegramFile> {
    return this.call("getFile", { file_id: fileId });
  }

  async downloadFile(filePath: string, destination: string, maxBytes: number): Promise<number> {
    const segments = filePath.split("/");
    if (!filePath || isAbsolute(filePath) || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("Telegram returned an invalid file path");
    }
    const url = `${this.fileBaseUrl}/${segments.map(encodeURIComponent).join("/")}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch {
      throw new Error("Telegram file download failed because of a network error");
    }
    if (!response.ok || !response.body) {
      throw new Error(`Telegram file download failed with HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    const declaredSize = contentLength === null ? null : Number(contentLength);
    if (declaredSize !== null && Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      throw new TelegramFileTooLargeError(maxBytes, declaredSize);
    }

    let downloaded = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > maxBytes) {
          callback(new TelegramFileTooLargeError(maxBytes, downloaded));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream),
        limiter,
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      );
      return downloaded;
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    attempts = 4,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        });
        const envelope = await response.json() as TelegramEnvelope<T>;
        if (!envelope.ok || envelope.result === undefined) {
          throw new TelegramApiError(
            envelope.description ?? `Telegram ${method} failed`,
            envelope.error_code ?? response.status,
            envelope.parameters?.retry_after,
          );
        }
        return envelope.result;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        const retryAfter = error instanceof TelegramApiError && error.code === 429
          ? (error.retryAfter ?? 1) * 1_000
          : 0;
        const retryable = retryAfter > 0 || !(error instanceof TelegramApiError) || error.code >= 500;
        if (!retryable || attempt === attempts - 1) throw error;
        const delay = retryAfter || Math.round(250 * 2 ** attempt * (0.75 + Math.random() * 0.5));
        this.log.warn("Retrying Telegram API call", { method, attempt: attempt + 1, delayMs: delay, error: String(error) });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }
}

export class TelegramFileTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly actualBytes?: number,
  ) {
    super(`File exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB download limit`);
    this.name = "TelegramFileTooLargeError";
  }
}
