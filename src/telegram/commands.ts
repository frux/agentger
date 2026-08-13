import type { AppServerClient } from "../app-server/client.js";
import type { ThreadItem } from "../app-server/generated/v2/ThreadItem.js";
import type { BridgeDatabase, TopicBinding } from "../db.js";
import { ThreadAlreadyBoundError, TopicAlreadyBoundError, TopicReservedError } from "../db.js";
import type { ProjectResolver } from "../projects.js";
import type { SessionManager } from "../sessions/manager.js";
import type { TelegramApi, TelegramMessage } from "./api.js";
import { splitTelegramText } from "./renderer.js";
import type { TopicRouter } from "./router.js";

type ParsedCommand = { name: string; argument: string };

function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([a-z-]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match?.[1]) return null;
  return { name: match[1].toLowerCase(), argument: match[2]?.trim() ?? "" };
}

export function isExplicitBindingCommand(text: string | undefined): boolean {
  if (!text) return false;
  const command = parseCommand(text);
  return command?.name === "codex-init" || command?.name === "codex-attach";
}

function userMessageText(item: Extract<ThreadItem, { type: "userMessage" }>): string {
  return item.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("\n");
}

function renderHistory(binding: TopicBinding, turns: Awaited<ReturnType<SessionManager["history"]>>["turns"]): string {
  const lines = [`История · ${binding.codexThreadId}`];
  for (const turn of turns.slice(-10)) {
    const messages: string[] = [];
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = userMessageText(item);
        if (text) messages.push(`Вы: ${text}`);
      } else if (item.type === "agentMessage" && item.text) {
        messages.push(`Codex: ${item.text}`);
      }
    }
    if (messages.length > 0) lines.push(`\n[${turn.status}]\n${messages.join("\n\n")}`);
  }
  if (lines.length === 1) lines.push("\nИстория пуста.");
  return lines.join("\n");
}

export class TelegramCommands {
  constructor(
    private readonly telegram: TelegramApi,
    private readonly db: BridgeDatabase,
    private readonly projects: ProjectResolver,
    private readonly router: TopicRouter,
    private readonly client: AppServerClient,
    private readonly sessions: SessionManager,
  ) {}

  async handle(message: TelegramMessage): Promise<boolean> {
    const command = message.text ? parseCommand(message.text) : null;
    if (!command) return false;
    switch (command.name) {
      case "codex-init":
        await this.init(message, command.argument);
        return true;
      case "codex-attach":
        await this.attach(message, command.argument);
        return true;
      case "codex-status":
        await this.status(message);
        return true;
      case "codex-stop":
        await this.stop(message);
        return true;
      case "codex-close":
        await this.close(message);
        return true;
      case "codex-diff":
        await this.diff(message);
        return true;
      case "codex-history":
        await this.history(message);
        return true;
      case "projects":
        await this.listProjects(message);
        return true;
      case "codex-help":
        await this.help(message);
        return true;
      default:
        return false;
    }
  }

  private async init(message: TelegramMessage, alias: string): Promise<void> {
    const threadId = message.message_thread_id;
    if (threadId === undefined) return this.reply(message, "Команда /codex-init работает только внутри Telegram topic.");
    if (!alias) return this.reply(message, "Использование: /codex-init <project>");
    const route = this.router.route(message.chat.id, threadId);
    if (route.type === "reserved") return this.reply(message, `Этот topic зарезервирован: ${route.purpose}`);
    if (route.type === "codex") return this.reply(message, `Topic уже подключён к thread ${route.binding.codexThreadId}`);
    try {
      const cwd = await this.projects.resolveAlias(alias);
      const started = await this.client.startThread(cwd);
      try {
        this.db.createBinding({
          telegramChatId: message.chat.id,
          telegramThreadId: threadId,
          codexThreadId: started.thread.id,
          workingDirectory: cwd,
          title: null,
        });
      } catch (error) {
        throw new Error(`Thread ${started.thread.id} создан, но binding не сохранён: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.sessions.registerLoaded(started.thread.id, started.model);
      await this.reply(message, `✅ Codex подключён\n\nThread: ${started.thread.id}\ncwd: ${cwd}\nmodel: ${started.model}`);
    } catch (error) {
      await this.reply(message, `❌ Не удалось подключить Codex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async attach(message: TelegramMessage, codexThreadId: string): Promise<void> {
    const telegramThreadId = message.message_thread_id;
    if (telegramThreadId === undefined) return this.reply(message, "Команда /codex-attach работает только внутри Telegram topic.");
    if (!codexThreadId || codexThreadId.length > 200 || /\s/u.test(codexThreadId)) {
      return this.reply(message, "Использование: /codex-attach <thread-id>");
    }
    const route = this.router.route(message.chat.id, telegramThreadId);
    if (route.type === "reserved") return this.reply(message, `Этот topic зарезервирован: ${route.purpose}`);
    if (route.type === "codex") return this.reply(message, `Topic уже подключён к thread ${route.binding.codexThreadId}`);
    const existing = this.db.getBindingByThread(codexThreadId);
    if (existing) {
      return this.reply(message, `Этот Codex thread уже подключён к topic ${existing.telegramThreadId} в чате ${existing.telegramChatId}.`);
    }
    try {
      const resumed = await this.client.resumeThread(codexThreadId);
      const cwd = await this.projects.validate(resumed.cwd);
      this.db.createBinding({
        telegramChatId: message.chat.id,
        telegramThreadId,
        codexThreadId: resumed.thread.id,
        workingDirectory: cwd,
        title: resumed.thread.name,
      });
      this.sessions.registerLoaded(resumed.thread.id, resumed.model);
      await this.reply(message, `✅ Существующий Codex thread подключён\n\nThread: ${resumed.thread.id}\ncwd: ${cwd}\nmodel: ${resumed.model}`);
    } catch (error) {
      const known = error instanceof TopicReservedError || error instanceof TopicAlreadyBoundError || error instanceof ThreadAlreadyBoundError;
      await this.reply(message, `❌ Не удалось подключить thread: ${known || error instanceof Error ? (error as Error).message : String(error)}`);
    }
  }

  private async status(message: TelegramMessage): Promise<void> {
    const binding = this.binding(message);
    if (!binding) return this.reply(message, "Этот topic не подключён к Codex.");
    try {
      await this.sessions.ensureLoaded(binding);
    } catch {
      // Snapshot below includes the recovery error and broken-binding state.
    }
    const snapshot = this.sessions.snapshot(binding.codexThreadId);
    const currentBinding = this.binding(message) ?? binding;
    const usage = snapshot.tokenUsage?.total;
    await this.reply(message, [
      `Thread: ${binding.codexThreadId}`,
      `cwd: ${binding.workingDirectory}`,
      `status: ${snapshot.status}`,
      `turn: ${snapshot.turnId ?? "—"}`,
      `model: ${snapshot.model ?? "—"}`,
      `queue: ${snapshot.queueLength}`,
      usage ? `tokens: ${usage.totalTokens} (in ${usage.inputTokens}, out ${usage.outputTokens})` : "tokens: —",
      currentBinding.brokenReason ? `binding: broken · ${currentBinding.brokenReason}` : "binding: ok",
      `app-server: ${this.client.health.ready ? "ready" : "restarting"} · ${this.client.health.version}`,
    ].join("\n"));
  }

  private async stop(message: TelegramMessage): Promise<void> {
    const binding = this.binding(message);
    if (!binding) return this.reply(message, "Этот topic не подключён к Codex.");
    try {
      const interrupted = await this.sessions.interrupt(binding.codexThreadId);
      await this.reply(message, interrupted ? "⏹ Запрос на остановку turn отправлен." : "Активного turn нет.");
    } catch (error) {
      await this.reply(message, `❌ Не удалось остановить turn: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async close(message: TelegramMessage): Promise<void> {
    const binding = this.binding(message);
    if (!binding) return this.reply(message, "Этот topic не подключён к Codex.");
    this.db.deleteBinding(binding.telegramChatId, binding.telegramThreadId);
    this.sessions.detach(binding.codexThreadId);
    await this.reply(message, `✅ Binding удалён. Codex thread ${binding.codexThreadId} сохранён. Следующее сообщение создаст новую session.`);
  }

  private async diff(message: TelegramMessage): Promise<void> {
    const binding = this.binding(message);
    if (!binding) return this.reply(message, "Этот topic не подключён к Codex.");
    const diff = this.sessions.getDiff(binding.codexThreadId);
    if (!diff) return this.reply(message, "Для текущего/последнего turn diff не получен.");
    await this.replyParts(message, diff);
  }

  private async history(message: TelegramMessage): Promise<void> {
    const binding = this.binding(message);
    if (!binding) return this.reply(message, "Этот topic не подключён к Codex.");
    try {
      const thread = await this.sessions.history(binding.codexThreadId);
      await this.replyParts(message, renderHistory(binding, thread.turns));
    } catch (error) {
      await this.reply(message, `❌ Не удалось прочитать историю: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async listProjects(message: TelegramMessage): Promise<void> {
    const projects = this.db.listProjects();
    await this.reply(message, projects.length === 0
      ? "Project aliases не настроены."
      : `Projects\n\n${projects.map((project) => `${project.name} → ${project.workingDirectory}`).join("\n")}`);
  }

  private help(message: TelegramMessage): Promise<void> {
    return this.reply(message, [
      "Agentger",
      "",
      "Новый незарезервированный topic автоматически создаёт Codex session.",
      "",
      "/codex-status — состояние",
      "/codex-stop — прервать активный turn",
      "/codex-diff — последний aggregated diff",
      "/codex-history — persisted history",
      "/codex-close — удалить только Telegram binding",
      "/projects — project aliases",
      "/codex-init <project> — создать session в другом project",
      "/codex-attach <thread-id> — подключить существующий thread",
      "/codex-help — помощь",
    ].join("\n"));
  }

  private binding(message: TelegramMessage): TopicBinding | null {
    return message.message_thread_id === undefined ? null : this.db.getBinding(message.chat.id, message.message_thread_id);
  }

  private async reply(message: TelegramMessage, text: string): Promise<void> {
    await this.telegram.sendMessage(message.chat.id, text, {
      ...(message.message_thread_id === undefined ? {} : { messageThreadId: message.message_thread_id }),
    });
  }

  private async replyParts(message: TelegramMessage, text: string): Promise<void> {
    for (const part of splitTelegramText(text)) await this.reply(message, part);
  }
}
