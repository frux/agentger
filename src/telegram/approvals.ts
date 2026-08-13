import { randomUUID } from "node:crypto";
import type { ServerRequest } from "../app-server/generated/ServerRequest.js";
import { RpcError } from "../app-server/rpc.js";
import type { BridgeDatabase } from "../db.js";
import type { SessionManager } from "../sessions/manager.js";
import type { TelegramCallbackQuery } from "./api.js";

export interface ApprovalTelegram {
  sendMessage(
    chatId: number,
    text: string,
    options: { messageThreadId: number; replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } },
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
  ): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown>;
}

type PendingApproval = {
  token: string;
  request: ServerRequest;
  chatId: number;
  threadId: number;
  messageId: number;
  timer: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  settled: boolean;
};

function requestThreadId(request: ServerRequest): string | null {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
    case "item/tool/requestUserInput":
      return request.params.threadId;
    case "execCommandApproval":
    case "applyPatchApproval":
      return request.params.conversationId;
    default:
      return null;
  }
}

function renderApproval(request: ServerRequest): string {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return [
        "⚠️ Codex просит разрешение",
        request.params.command ? `Команда:\n${request.params.command}` : "Сетевой доступ",
        request.params.cwd ? `cwd:\n${request.params.cwd}` : "",
        request.params.reason ? `Причина:\n${request.params.reason}` : "",
      ].filter(Boolean).join("\n\n");
    case "item/fileChange/requestApproval":
      return [
        "⚠️ Codex просит разрешение на изменение файлов",
        request.params.grantRoot ? `Путь:\n${request.params.grantRoot}` : "",
        request.params.reason ? `Причина:\n${request.params.reason}` : "",
      ].filter(Boolean).join("\n\n");
    case "execCommandApproval":
      return [
        "⚠️ Codex просит разрешение",
        `Команда:\n${request.params.command.join(" ")}`,
        `cwd:\n${request.params.cwd}`,
        request.params.reason ? `Причина:\n${request.params.reason}` : "",
      ].filter(Boolean).join("\n\n");
    case "applyPatchApproval":
      return [
        "⚠️ Codex просит разрешение на изменение файлов",
        `Файлы:\n${Object.keys(request.params.fileChanges).slice(0, 20).join("\n")}`,
        request.params.reason ? `Причина:\n${request.params.reason}` : "",
      ].filter(Boolean).join("\n\n");
    default:
      return `⚠️ Неподдерживаемый запрос Codex: ${request.method}`;
  }
}

function decisionFor(request: ServerRequest, allow: boolean): unknown {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: allow ? "accept" : "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: allow ? "approved" : { denied: { rejection: "Denied via Telegram" } } };
    default:
      throw new RpcError(`Unsupported approval request: ${request.method}`, -32601);
  }
}

export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly resolved = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly telegram: ApprovalTelegram,
    private readonly db: BridgeDatabase,
    private readonly sessions: Pick<SessionManager, "setWaitingApproval">,
    private readonly allowedUserIds: Set<number>,
    private readonly timeoutMs: number,
  ) {}

  readonly handleServerRequest = async (request: ServerRequest): Promise<unknown> => {
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"].includes(request.method)) {
      throw new RpcError(`Unsupported server request: ${request.method}`, -32601);
    }
    const codexThreadId = requestThreadId(request);
    if (!codexThreadId) throw new RpcError("Approval request has no thread id", -32602);
    const binding = this.db.getBindingByThread(codexThreadId);
    if (!binding) return decisionFor(request, false);
    const token = randomUUID();
    const message = await this.telegram.sendMessage(binding.telegramChatId, renderApproval(request), {
      messageThreadId: binding.telegramThreadId,
      replyMarkup: {
        inline_keyboard: [[
          { text: "Разрешить", callback_data: `ca:${token}:a` },
          { text: "Отклонить", callback_data: `ca:${token}:d` },
        ]],
      },
    });
    this.sessions.setWaitingApproval(codexThreadId, true);
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        const approval = this.pending.get(token);
        if (approval) void this.settle(approval, false, "⌛ Время ожидания истекло");
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(token, {
        token,
        request,
        chatId: binding.telegramChatId,
        threadId: binding.telegramThreadId,
        messageId: message.message_id,
        timer,
        resolve,
        settled: false,
      });
    });
  };

  async handleCallback(query: TelegramCallbackQuery): Promise<boolean> {
    const match = /^ca:([0-9a-f-]{36}):([ad])$/u.exec(query.data ?? "");
    if (!match) return false;
    if (!this.allowedUserIds.has(query.from.id)) {
      await this.telegram.answerCallbackQuery(query.id, "Нет доступа");
      return true;
    }
    const token = match[1];
    const allow = match[2] === "a";
    if (!token) return false;
    const approval = this.pending.get(token);
    if (!approval) {
      const text = this.resolved.has(token) ? "Решение уже принято" : "Запрос истёк";
      await this.telegram.answerCallbackQuery(query.id, text);
      return true;
    }
    if (query.message?.chat.id !== approval.chatId || query.message.message_thread_id !== approval.threadId) {
      await this.telegram.answerCallbackQuery(query.id, "Этот запрос относится к другому topic");
      return true;
    }
    await this.telegram.answerCallbackQuery(query.id, allow ? "Разрешено" : "Отклонено");
    await this.settle(approval, allow, allow ? "✅ Разрешено" : "❌ Отклонено");
    return true;
  }

  cancelAll(): void {
    for (const approval of [...this.pending.values()]) void this.settle(approval, false, "❌ app-server отключён");
  }

  get size(): number {
    return this.pending.size;
  }

  private async settle(approval: PendingApproval, allow: boolean, label: string): Promise<void> {
    if (approval.settled) return;
    approval.settled = true;
    clearTimeout(approval.timer);
    this.pending.delete(approval.token);
    const expiry = setTimeout(() => this.resolved.delete(approval.token), 5 * 60_000);
    expiry.unref?.();
    this.resolved.set(approval.token, expiry);
    const codexThreadId = requestThreadId(approval.request);
    if (codexThreadId) this.sessions.setWaitingApproval(codexThreadId, false);
    approval.resolve(decisionFor(approval.request, allow));
    try {
      await this.telegram.editMessageText(approval.chatId, approval.messageId, `${renderApproval(approval.request)}\n\n${label}`, { inline_keyboard: [] });
    } catch {
      // The RPC decision is more important than a cosmetic Telegram edit.
    }
  }
}
