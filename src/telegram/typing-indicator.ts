import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";

export interface ChatActionTelegram {
  sendChatAction(chatId: number, action: "typing", messageThreadId?: number): Promise<true>;
}

export class TypingIndicator {
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private waitingForUser = false;
  private readonly log: Logger;

  constructor(
    private readonly telegram: ChatActionTelegram,
    private readonly chatId: number,
    private readonly threadId: number,
    private readonly refreshIntervalMs = 4_000,
    logger?: Logger,
  ) {
    this.log = logger ?? defaultLogger;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule();
  }

  setWaitingForUser(waiting: boolean): void {
    if (this.waitingForUser === waiting) return;
    this.waitingForUser = waiting;
    if (waiting) {
      this.clearTimer();
    } else if (this.active) {
      this.schedule();
    }
  }

  stop(): void {
    this.active = false;
    this.clearTimer();
  }

  private schedule(): void {
    if (!this.active || this.waitingForUser || this.timer) return;
    void this.telegram.sendChatAction(this.chatId, "typing", this.threadId).catch((error: unknown) => {
      this.log.warn("Telegram typing indicator failed", { error: String(error) });
    });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, this.refreshIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
