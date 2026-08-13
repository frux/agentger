import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import type { SessionManager } from "../sessions/manager.js";
import type { ApprovalManager } from "./approvals.js";
import type { TelegramApi, TelegramMessage, TelegramUpdate } from "./api.js";
import type { TelegramCommands } from "./commands.js";
import type { TopicRouter } from "./router.js";
import type { TopicProvisioner } from "./topics.js";
import { isExplicitBindingCommand } from "./commands.js";
import type { TopicBinding } from "../db.js";
import { TelegramTurnSink } from "./turn-sink.js";

export interface TelegramBotOptions {
  allowedUserIds: Set<number>;
  longPollSeconds: number;
  streamUpdateIntervalMs: number;
  completionReactionCustomEmojiId: string | null;
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
    private readonly topics: TopicProvisioner,
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
    const route = this.router.route(message.chat.id, message.message_thread_id);
    if (route.type === "reserved") return;
    if (message.forum_topic_created) {
      await this.topics.ensure(message, true);
      return;
    }
    if (isExplicitBindingCommand(message.text)) {
      await this.commands.handle(message);
      return;
    }
    const binding = await this.topics.ensure(message, false);
    if (!binding) return;
    if (await this.commands.handle(message)) return;
    await this.handleText(message, binding);
  }

  private async handleText(message: TelegramMessage, binding: TopicBinding): Promise<void> {
    const text = message.text?.trim();
    if (!text) return;
    const sink = new TelegramTurnSink(
      this.telegram,
      binding.telegramChatId,
      binding.telegramThreadId,
      {
        streamUpdateIntervalMs: this.options.streamUpdateIntervalMs,
        completionReactionCustomEmojiId: this.options.completionReactionCustomEmojiId,
        inboundMessageId: message.message_id,
        logger: this.log,
      },
    );
    const clientUserMessageId = `tg:${message.chat.id}:${binding.telegramThreadId}:${message.message_id}`;
    void this.sessions.enqueue(binding, text, clientUserMessageId, sink).catch(() => undefined);
  }
}
