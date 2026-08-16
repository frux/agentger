import type { SendMessageOptions, SendRichMessageOptions, TelegramApi } from "./api.js";
import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import { splitTelegramText } from "./renderer.js";

const RICH_MESSAGE_LIMIT = 32_000;

export type TelegramMessageFormat = SendMessageOptions["parseMode"] | "RichMarkdown";

export interface TelegramMessageEditor {
  sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: SendMessageOptions["replyMarkup"],
    parseMode?: SendMessageOptions["parseMode"],
  ): Promise<unknown>;
  sendRichMessage?(
    chatId: number,
    markdown: string,
    options?: SendRichMessageOptions,
  ): Promise<{ message_id: number }>;
  editRichMessage?(chatId: number, messageId: number, markdown: string): Promise<unknown>;
}

export class StreamingMessage {
  private messageId: number | null = null;
  private pendingText: string | null = null;
  private lastText = "";
  private lastEditAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private lastMessageId: number | null = null;

  constructor(
    private readonly telegram: TelegramMessageEditor | TelegramApi,
    private readonly chatId: number,
    private readonly threadId: number,
    private readonly intervalMs = 750,
    private readonly format?: TelegramMessageFormat,
    private readonly disableNotification = false,
    private readonly log: Logger = defaultLogger,
  ) {}

  async start(text = "…"): Promise<number> {
    if (this.messageId !== null) return this.lastMessageId ?? this.messageId;
    const [first = "…"] = splitTelegramText(text);
    const message = await this.telegram.sendMessage(this.chatId, first, {
      messageThreadId: this.threadId,
      ...(this.format === "MarkdownV2" ? { parseMode: this.format } : {}),
      ...(this.disableNotification ? { disableNotification: true } : {}),
    });
    this.messageId = message.message_id;
    this.lastMessageId = message.message_id;
    this.lastText = first;
    this.lastEditAt = Date.now();
    return message.message_id;
  }

  update(text: string): void {
    if (this.closed) return;
    const [first = "…"] = splitTelegramText(text);
    this.pendingText = first;
    const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastEditAt));
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueFlush();
    }, wait);
    this.timer.unref?.();
  }

  async finish(text: string): Promise<number | null> {
    if (this.closed) return this.lastMessageId;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingText = null;
    await this.chain;
    if (this.format === "RichMarkdown") return await this.finishRich(text);
    const parts = splitTelegramText(text);
    const first = parts.shift() ?? "…";
    if (this.messageId === null) {
      await this.start(first);
    } else if (first !== this.lastText) {
      await this.telegram.editMessageText(this.chatId, this.messageId, first, undefined, this.format);
      this.lastText = first;
    }
    for (const part of parts) {
      const message = await this.telegram.sendMessage(this.chatId, part, {
        messageThreadId: this.threadId,
        ...(this.format === "MarkdownV2" ? { parseMode: this.format } : {}),
        ...(this.disableNotification ? { disableNotification: true } : {}),
      });
      this.lastMessageId = message.message_id;
    }
    return this.lastMessageId;
  }

  async failed(error: unknown): Promise<number | null> {
    return this.finish(`❌ ${error instanceof Error ? error.message : String(error)}`);
  }

  private enqueueFlush(): void {
    const text = this.pendingText;
    this.pendingText = null;
    if (!text || text === this.lastText) return;
    this.chain = this.chain.then(async () => {
      await this.start();
      if (this.messageId === null || text === this.lastText) return;
      await this.telegram.editMessageText(
        this.chatId,
        this.messageId,
        text,
        undefined,
        this.format === "MarkdownV2" ? this.format : undefined,
      );
      this.lastText = text;
      this.lastEditAt = Date.now();
    }).catch(() => undefined);
  }

  private async finishRich(text: string): Promise<number | null> {
    const parts = splitTelegramText(text, RICH_MESSAGE_LIMIT);
    const first = parts.shift() ?? "…";
    if (this.messageId === null) {
      const rich = await this.trySendRich(first);
      if (rich) {
        this.messageId = rich.message_id;
        this.lastMessageId = rich.message_id;
        this.lastText = first;
      } else {
        await this.sendPlainParts(first);
      }
    } else {
      const edited = await this.tryEditRich(this.messageId, first);
      if (edited) {
        this.lastText = first;
      } else {
        await this.replaceWithPlainParts(this.messageId, first);
      }
    }
    for (const part of parts) {
      const rich = await this.trySendRich(part);
      if (rich) {
        this.lastMessageId = rich.message_id;
      } else {
        await this.sendPlainParts(part);
      }
    }
    return this.lastMessageId;
  }

  private async tryEditRich(messageId: number, markdown: string): Promise<boolean> {
    if (!this.telegram.editRichMessage) return false;
    try {
      await this.telegram.editRichMessage(this.chatId, messageId, markdown);
      return true;
    } catch (error) {
      this.log.warn("Telegram rich message edit failed; falling back to plain text", { error: String(error) });
      return false;
    }
  }

  private async trySendRich(markdown: string): Promise<{ message_id: number } | null> {
    if (!this.telegram.sendRichMessage) return null;
    try {
      return await this.telegram.sendRichMessage(this.chatId, markdown, {
        messageThreadId: this.threadId,
        ...(this.disableNotification ? { disableNotification: true } : {}),
      });
    } catch (error) {
      this.log.warn("Telegram rich message send failed; falling back to plain text", { error: String(error) });
      return null;
    }
  }

  private async replaceWithPlainParts(messageId: number, text: string): Promise<void> {
    const parts = splitTelegramText(text);
    const first = parts.shift() ?? "…";
    await this.telegram.editMessageText(this.chatId, messageId, first);
    this.lastText = first;
    await this.sendPlainParts(parts);
  }

  private async sendPlainParts(text: string | string[]): Promise<void> {
    const parts = typeof text === "string" ? splitTelegramText(text) : text;
    for (const part of parts) {
      const message = await this.telegram.sendMessage(this.chatId, part, {
        messageThreadId: this.threadId,
        ...(this.disableNotification ? { disableNotification: true } : {}),
      });
      this.lastMessageId = message.message_id;
    }
  }
}
