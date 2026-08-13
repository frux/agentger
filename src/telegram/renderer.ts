import type { ServerNotification } from "../app-server/generated/ServerNotification.js";
import type { ThreadItem } from "../app-server/generated/v2/ThreadItem.js";
import type { ThreadTokenUsage } from "../app-server/generated/v2/ThreadTokenUsage.js";
import type { TurnPlanStep } from "../app-server/generated/v2/TurnPlanStep.js";

const OUTPUT_PREVIEW = 500;

function clean(text: string): string {
  return text.replace(/\u0000/gu, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
}

function preview(text: string, limit = OUTPUT_PREVIEW): string {
  const value = clean(text).trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function itemSummary(item: ThreadItem): string | null {
  switch (item.type) {
    case "commandExecution": {
      if (item.status === "inProgress") return `⚙️ ${preview(item.command, 300)}\nrunning…`;
      const icon = item.status === "completed" && item.exitCode === 0 ? "✅" : item.status === "declined" ? "⛔" : "❌";
      const duration = item.durationMs === null ? "" : ` · ${(item.durationMs / 1_000).toFixed(1)}s`;
      const output = item.aggregatedOutput ? `\n${preview(item.aggregatedOutput)}` : "";
      return `${icon} ${preview(item.command, 300)}\n${item.status}${item.exitCode === null ? "" : ` · exit ${item.exitCode}`}${duration}${output}`;
    }
    case "mcpToolCall": {
      const icon = item.status === "inProgress" ? "🔧" : item.status === "completed" ? "✅" : "❌";
      return `${icon} MCP: ${item.server}/${item.tool} · ${item.status}`;
    }
    case "dynamicToolCall": {
      const icon = item.status === "inProgress" ? "🔧" : item.success ? "✅" : "❌";
      return `${icon} Tool: ${item.namespace ? `${item.namespace}/` : ""}${item.tool} · ${item.status}`;
    }
    case "webSearch":
      return "🔎 Web search";
    case "imageView":
      return `🖼 Просмотр: ${preview(item.path, 300)}`;
    default:
      return null;
  }
}

export class TurnRenderer {
  private readonly agentMessages = new Map<string, string>();
  private readonly reasoning = new Map<string, string>();
  private readonly activities = new Map<string, string>();
  private readonly changedFiles = new Set<string>();
  private plan: TurnPlanStep[] = [];
  private explanation: string | null = null;
  private status: "starting" | "working" | "completed" | "interrupted" | "failed" = "starting";
  private error: string | null = null;
  diff = "";
  tokenUsage: ThreadTokenUsage | null = null;
  turnId: string | null = null;

  consume(notification: ServerNotification): void {
    const { method, params } = notification;
    switch (method) {
      case "turn/started":
        this.turnId = params.turn.id;
        this.status = "working";
        break;
      case "item/agentMessage/delta":
        this.agentMessages.set(params.itemId, (this.agentMessages.get(params.itemId) ?? "") + params.delta);
        break;
      case "item/reasoning/summaryTextDelta":
        this.reasoning.set(params.itemId, (this.reasoning.get(params.itemId) ?? "") + params.delta);
        break;
      case "item/started":
      case "item/completed":
        this.consumeItem(params.item);
        break;
      case "turn/plan/updated":
        this.plan = params.plan;
        this.explanation = params.explanation;
        break;
      case "turn/diff/updated":
        this.diff = params.diff;
        break;
      case "thread/tokenUsage/updated":
        this.tokenUsage = params.tokenUsage;
        break;
      case "error":
        this.error = params.error.message;
        break;
      case "turn/completed": {
        this.turnId = params.turn.id;
        this.status = params.turn.status === "completed"
          ? "completed"
          : params.turn.status === "interrupted"
            ? "interrupted"
            : "failed";
        if (params.turn.error) this.error = params.turn.error.message;
        for (const item of params.turn.items) this.consumeItem(item);
        break;
      }
      default:
        break;
    }
  }

  private consumeItem(item: ThreadItem): void {
    if (item.type === "agentMessage") {
      this.agentMessages.set(item.id, item.text);
      return;
    }
    if (item.type === "reasoning") {
      const summary = item.summary.join("\n");
      if (summary) this.reasoning.set(item.id, summary);
      return;
    }
    if (item.type === "fileChange") {
      for (const change of item.changes) this.changedFiles.add(change.path);
      return;
    }
    const summary = itemSummary(item);
    if (summary && "id" in item) this.activities.set(item.id, summary);
  }

  render(): string {
    const sections = ["Codex", this.statusText()];
    const reasoning = preview([...this.reasoning.values()].join("\n"), 1_000);
    if (reasoning) sections.push(`Ход работы\n${reasoning}`);
    if (this.plan.length > 0) sections.push(`План${this.explanation ? `\n${preview(this.explanation, 500)}` : ""}\n${this.renderPlan()}`);
    if (this.activities.size > 0) sections.push([...this.activities.values()].slice(-6).join("\n\n"));
    if (this.changedFiles.size > 0) sections.push(`✏️ Изменено файлов: ${this.changedFiles.size}`);
    const answer = clean([...this.agentMessages.values()].join("\n")).trim();
    if (answer) sections.push(answer);
    if (this.error) sections.push(`Ошибка: ${preview(this.error, 1_000)}`);
    return sections.filter(Boolean).join("\n\n");
  }

  private statusText(): string {
    switch (this.status) {
      case "starting": return "Запускаю…";
      case "working": return "Выполняется…";
      case "completed": return "✅ Готово";
      case "interrupted": return "⏹ Остановлено";
      case "failed": return "❌ Ошибка";
    }
  }

  private renderPlan(): string {
    return this.plan.map((step) => {
      const icon = step.status === "completed" ? "✅" : step.status === "inProgress" ? "🔄" : "○";
      return `${icon} ${step.step}`;
    }).join("\n");
  }
}

export function splitTelegramText(text: string, limit = 4_000): string[] {
  const cleanText = clean(text).trim() || "…";
  const parts: string[] = [];
  let rest = cleanText;
  while (rest.length > limit) {
    let end = rest.lastIndexOf("\n", limit);
    if (end < Math.floor(limit * 0.5)) end = rest.lastIndexOf(" ", limit);
    if (end < Math.floor(limit * 0.5)) end = limit;
    parts.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
