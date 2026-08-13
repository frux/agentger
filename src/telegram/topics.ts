import type { ThreadStartResponse } from "../app-server/generated/v2/ThreadStartResponse.js";
import type { BridgeDatabase, TopicBinding } from "../db.js";
import { TopicAlreadyBoundError } from "../db.js";
import type { ProjectResolver } from "../projects.js";
import type { SessionManager } from "../sessions/manager.js";
import type { TelegramMessage } from "./api.js";
import type { TopicRouter } from "./router.js";

export interface TopicTelegram {
  sendMessage(chatId: number, text: string, options: { messageThreadId: number }): Promise<unknown>;
}

export interface TopicAppServer {
  startThread(cwd: string): Promise<ThreadStartResponse>;
  unsubscribeThread(threadId: string): Promise<void>;
}

export class TopicProvisioner {
  constructor(
    private readonly telegram: TopicTelegram,
    private readonly db: BridgeDatabase,
    private readonly projects: Pick<ProjectResolver, "resolveDefault">,
    private readonly router: TopicRouter,
    private readonly client: TopicAppServer,
    private readonly sessions: Pick<SessionManager, "registerLoaded">,
    private readonly defaultProject: string | null,
  ) {}

  async ensure(message: TelegramMessage, announce: boolean): Promise<TopicBinding | null> {
    const telegramThreadId = message.message_thread_id;
    if (telegramThreadId === undefined) return null;
    const route = this.router.route(message.chat.id, telegramThreadId);
    if (route.type === "reserved" || route.type === "not-topic") return null;
    if (route.type === "codex") return route.binding;

    try {
      const cwd = await this.projects.resolveDefault(this.defaultProject);
      const started = await this.client.startThread(cwd);
      let binding: TopicBinding;
      try {
        binding = this.db.createBinding({
          telegramChatId: message.chat.id,
          telegramThreadId,
          codexThreadId: started.thread.id,
          workingDirectory: cwd,
          title: message.forum_topic_created?.name ?? null,
        });
      } catch (error) {
        if (!(error instanceof TopicAlreadyBoundError)) throw error;
        await this.client.unsubscribeThread(started.thread.id).catch(() => undefined);
        const existing = this.db.getBinding(message.chat.id, telegramThreadId);
        if (!existing) throw error;
        return existing;
      }
      this.sessions.registerLoaded(binding.codexThreadId, started.model);
      if (announce) {
        await this.telegram.sendMessage(message.chat.id, [
          "✅ Agentger создал Codex session",
          "",
          `Thread: ${binding.codexThreadId}`,
          `cwd: ${binding.workingDirectory}`,
        ].join("\n"), { messageThreadId: telegramThreadId });
      }
      return binding;
    } catch (error) {
      await this.telegram.sendMessage(message.chat.id, [
        "❌ Agentger не смог создать Codex session",
        "",
        error instanceof Error ? error.message : String(error),
      ].join("\n"), { messageThreadId: telegramThreadId });
      return null;
    }
  }
}
