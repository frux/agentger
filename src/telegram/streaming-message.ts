import type { TelegramApi } from "./api.js";
import { splitTelegramText } from "./renderer.js";

export interface TelegramMessageEditor {
  sendMessage(chatId: number, text: string, options?: { messageThreadId?: number }): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<unknown>;
}

export class StreamingMessage {
  private messageId: number | null = null;
  private pendingText: string | null = null;
  private lastText = "";
  private lastEditAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly telegram: TelegramMessageEditor | TelegramApi,
    private readonly chatId: number,
    private readonly threadId: number,
    private readonly intervalMs = 750,
  ) {}

  async start(text = "Codex\n\nЗапускаю…"): Promise<void> {
    if (this.messageId !== null) return;
    const [first = "…"] = splitTelegramText(text);
    const message = await this.telegram.sendMessage(this.chatId, first, { messageThreadId: this.threadId });
    this.messageId = message.message_id;
    this.lastText = first;
    this.lastEditAt = Date.now();
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

  async finish(text: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingText = null;
    await this.start();
    await this.chain;
    const parts = splitTelegramText(text);
    const first = parts.shift() ?? "…";
    if (this.messageId !== null && first !== this.lastText) {
      await this.telegram.editMessageText(this.chatId, this.messageId, first);
      this.lastText = first;
    }
    for (const part of parts) {
      await this.telegram.sendMessage(this.chatId, part, { messageThreadId: this.threadId });
    }
  }

  async failed(error: unknown): Promise<void> {
    await this.finish(`Codex\n\n❌ Ошибка\n\n${error instanceof Error ? error.message : String(error)}`);
  }

  private enqueueFlush(): void {
    const text = this.pendingText;
    this.pendingText = null;
    if (!text || text === this.lastText) return;
    this.chain = this.chain.then(async () => {
      await this.start();
      if (this.messageId === null || text === this.lastText) return;
      await this.telegram.editMessageText(this.chatId, this.messageId, text);
      this.lastText = text;
      this.lastEditAt = Date.now();
    }).catch(() => undefined);
  }
}
