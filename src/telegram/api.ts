import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";

export interface TelegramUser {
  id: number;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
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
}

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

  constructor(
    token: string,
    private readonly log: Logger = defaultLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!token) throw new Error("Telegram bot token is required");
    this.baseUrl = `https://api.telegram.org/bot${token}`;
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
      disable_web_page_preview: true,
    });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: SendMessageOptions["replyMarkup"],
  ): Promise<TelegramMessage | true> {
    return this.call<TelegramMessage | true>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
      disable_web_page_preview: true,
    }).catch((error: unknown) => {
      if (error instanceof TelegramApiError && error.message.includes("message is not modified")) return true;
      throw error;
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<true> {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text === undefined ? {} : { text }),
    });
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
