import type { ServerNotification } from "../app-server/generated/ServerNotification.js";
import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import type { TurnSink } from "../sessions/manager.js";
import type { TelegramReaction } from "./api.js";
import { TurnRenderer, type TurnMessageUpdate } from "./renderer.js";
import { StreamingMessage, type TelegramMessageEditor } from "./streaming-message.js";
import { TypingIndicator, type ChatActionTelegram } from "./typing-indicator.js";

export interface TurnTelegram extends TelegramMessageEditor, ChatActionTelegram {
  setMessageReaction(chatId: number, messageId: number, reaction: TelegramReaction): Promise<true>;
}

export interface TelegramTurnSinkOptions {
  streamUpdateIntervalMs: number;
  completionReactionCustomEmojiId: string | null;
  inboundMessageId: number;
  typingRefreshIntervalMs?: number;
  logger?: Logger;
}

export class TelegramTurnSink implements TurnSink {
  private readonly renderer = new TurnRenderer();
  private readonly messages = new Map<string, StreamingMessage>();
  private chain: Promise<void> = Promise.resolve();
  private lastAgentMessageId: number | null = null;
  private inputMarked = false;
  private readonly log: Logger;
  private readonly typing: TypingIndicator;

  constructor(
    private readonly telegram: TurnTelegram,
    private readonly chatId: number,
    private readonly threadId: number,
    private readonly options: TelegramTurnSinkOptions,
  ) {
    this.log = options.logger ?? defaultLogger;
    this.typing = new TypingIndicator(
      telegram,
      chatId,
      threadId,
      options.typingRefreshIntervalMs,
      this.log,
    );
  }

  onProcessingStarted(): void {
    this.typing.start();
  }

  onInputAccepted(): void {
    this.markInputAccepted();
  }

  private markInputAccepted(): void {
    if (this.inputMarked) return;
    this.inputMarked = true;
    void this.schedule(async () => {
      await this.telegram.setMessageReaction(this.chatId, this.options.inboundMessageId, {
        type: "emoji",
        emoji: "👀",
      });
    });
  }

  setWaitingForUser(waiting: boolean): void {
    this.typing.setWaitingForUser(waiting);
  }

  onNotification(notification: ServerNotification): void {
    if (notification.method === "turn/started") this.markInputAccepted();
    if (notification.method === "turn/completed") this.typing.stop();
    const updates = this.renderer.consume(notification);
    void this.schedule(async () => {
      for (const update of updates) await this.apply(update);
      if (notification.method === "turn/completed" && notification.params.turn.status === "completed") {
        await this.reactToCompletion();
      }
    });
  }

  onError(error: unknown): Promise<void> {
    this.typing.stop();
    return this.schedule(async () => {
      await this.telegram.sendMessage(
        this.chatId,
        `❌ ${error instanceof Error ? error.message : String(error)}`,
        { messageThreadId: this.threadId },
      );
    });
  }

  drain(): Promise<void> {
    return this.chain;
  }

  private schedule(task: () => Promise<void>): Promise<void> {
    const scheduled = this.chain.then(task);
    this.chain = scheduled.catch((error: unknown) => {
      this.log.warn("Failed to render Telegram turn event", { error: String(error) });
    });
    return scheduled;
  }

  private async apply(update: TurnMessageUpdate): Promise<void> {
    if (!update.text) return;
    let message = this.messages.get(update.key);
    if (!message) {
      message = new StreamingMessage(
        this.telegram,
        this.chatId,
        this.threadId,
        this.options.streamUpdateIntervalMs,
        update.parseMode,
      );
      this.messages.set(update.key, message);
      const messageId = await message.start(update.text);
      if (update.kind === "agent") this.lastAgentMessageId = messageId;
    } else if (!update.completed) {
      message.update(update.text);
    }
    if (update.completed) {
      const messageId = await message.finish(update.text);
      if (update.kind === "agent" && messageId !== null) this.lastAgentMessageId = messageId;
    }
  }

  private async reactToCompletion(): Promise<void> {
    if (this.lastAgentMessageId === null) return;
    const customId = this.options.completionReactionCustomEmojiId?.trim();
    if (customId) {
      try {
        await this.telegram.setMessageReaction(this.chatId, this.lastAgentMessageId, {
          type: "custom_emoji",
          custom_emoji_id: customId,
        });
        return;
      } catch (error) {
        this.log.warn("Custom completion reaction failed; falling back to 👍", { error: String(error) });
      }
    }
    try {
      await this.telegram.setMessageReaction(this.chatId, this.lastAgentMessageId, {
        type: "emoji",
        emoji: "👍",
      });
    } catch (error) {
      this.log.warn("Completion reaction failed", { error: String(error) });
    }
  }
}
