import type { ServerNotification } from "../app-server/generated/ServerNotification.js";
import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import type { SessionManager, TurnSink } from "../sessions/manager.js";
import type { ApprovalManager } from "./approvals.js";
import type { TelegramApi, TelegramMessage, TelegramUpdate } from "./api.js";
import type { TelegramCommands } from "./commands.js";
import { TurnRenderer } from "./renderer.js";
import type { TopicRouter } from "./router.js";
import { StreamingMessage } from "./streaming-message.js";

class TelegramTurnSink implements TurnSink {
  private readonly renderer = new TurnRenderer();
  private finished = false;

  constructor(private readonly message: StreamingMessage) {}

  onNotification(notification: ServerNotification): void {
    this.renderer.consume(notification);
    if (notification.method === "turn/completed") {
      this.finished = true;
      void this.message.finish(this.renderer.render());
    } else {
      this.message.update(this.renderer.render());
    }
  }

  async onError(error: unknown): Promise<void> {
    if (!this.finished) {
      this.finished = true;
      await this.message.failed(error);
    }
  }
}

export interface TelegramBotOptions {
  allowedUserIds: Set<number>;
  longPollSeconds: number;
  streamUpdateIntervalMs: number;
  logger?: Logger;
}

export class TelegramBot {
  private stopping = false;
  private offset = 0;
  private pollAbort: AbortController | null = null;
  private readonly log: Logger;

  constructor(
    private readonly telegram: TelegramApi,
    private readonly commands: TelegramCommands,
    private readonly approvals: ApprovalManager,
    private readonly router: TopicRouter,
    private readonly sessions: SessionManager,
    private readonly options: TelegramBotOptions,
  ) {
    this.log = options.logger ?? defaultLogger;
  }

  async run(): Promise<void> {
    this.stopping = false;
    this.log.info("Telegram long polling started");
    while (!this.stopping) {
      this.pollAbort = new AbortController();
      try {
        const updates = await this.telegram.getUpdates(this.offset, this.options.longPollSeconds, this.pollAbort.signal);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          try {
            await this.handleUpdate(update);
          } catch (error) {
            this.log.error("Telegram update failed", { updateId: update.update_id, error: String(error) });
          }
        }
      } catch (error) {
        if (this.stopping) break;
        this.log.warn("Telegram long poll failed", { error: String(error) });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      } finally {
        this.pollAbort = null;
      }
    }
  }

  stop(): void {
    this.stopping = true;
    this.pollAbort?.abort();
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.approvals.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.from || !this.options.allowedUserIds.has(message.from.id)) return;
    if (await this.commands.handle(message)) return;
    await this.handleText(message);
  }

  private async handleText(message: TelegramMessage): Promise<void> {
    const text = message.text?.trim();
    if (!text) return;
    const route = this.router.route(message.chat.id, message.message_thread_id);
    if (route.type !== "codex") return;
    const streaming = new StreamingMessage(
      this.telegram,
      route.binding.telegramChatId,
      route.binding.telegramThreadId,
      this.options.streamUpdateIntervalMs,
    );
    await streaming.start();
    const sink = new TelegramTurnSink(streaming);
    const clientUserMessageId = `tg:${message.chat.id}:${route.binding.telegramThreadId}:${message.message_id}`;
    void this.sessions.enqueue(route.binding, text, clientUserMessageId, sink).catch(() => undefined);
  }
}
