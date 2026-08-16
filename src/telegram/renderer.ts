import type { ServerNotification } from "../app-server/generated/ServerNotification.js";
import type { ThreadItem } from "../app-server/generated/v2/ThreadItem.js";
import type { ThreadTokenUsage } from "../app-server/generated/v2/ThreadTokenUsage.js";
import type { TurnPlanStep } from "../app-server/generated/v2/TurnPlanStep.js";

const TEXT_PREVIEW = 3_500;

export type TurnMessageKind = "agent" | "reasoning" | "plan" | "command" | "tool" | "files" | "error";

export interface TurnMessageUpdate {
  key: string;
  kind: TurnMessageKind;
  text: string;
  completed: boolean;
  format?: "MarkdownV2" | "RichMarkdown";
}

function clean(text: string): string {
  return text.replace(/\u0000/gu, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
}

function preview(text: string, limit = TEXT_PREVIEW): string {
  const value = clean(text).trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function markdownCode(text: string): string {
  const escaped = preview(text).replace(/\\/gu, "\\\\").replace(/`/gu, "\\`");
  return `\`\`\`bash\n${escaped}\n\`\`\``;
}

function renderPlan(plan: TurnPlanStep[], explanation: string | null): string {
  const lines = plan.map((step) => {
    const icon = step.status === "completed" ? "✓" : step.status === "inProgress" ? "→" : "·";
    return `${icon} ${step.step}`;
  });
  return [explanation ? preview(explanation, 500) : "", ...lines].filter(Boolean).join("\n");
}

function toolName(item: ThreadItem): string | null {
  switch (item.type) {
    case "mcpToolCall":
      return `${item.server}/${item.tool}`;
    case "dynamicToolCall":
      return `${item.namespace ? `${item.namespace}/` : ""}${item.tool}`;
    case "collabAgentToolCall":
      return `collaboration/${item.tool}`;
    case "webSearch":
      return "web/search";
    case "imageView":
      return "view/image";
    case "imageGeneration":
      return "image/generate";
    default:
      return null;
  }
}

function toolFailed(item: ThreadItem): boolean {
  return (item.type === "mcpToolCall" && item.status === "failed")
    || (item.type === "dynamicToolCall" && (item.status === "failed" || item.success === false));
}

export class TurnRenderer {
  private readonly agentMessages = new Map<string, string>();
  private readonly reasoning = new Map<string, string>();
  diff = "";
  tokenUsage: ThreadTokenUsage | null = null;
  turnId: string | null = null;

  consume(notification: ServerNotification): TurnMessageUpdate[] {
    const { method, params } = notification;
    switch (method) {
      case "turn/started":
        this.turnId = params.turn.id;
        return [];
      case "item/agentMessage/delta": {
        const text = (this.agentMessages.get(params.itemId) ?? "") + params.delta;
        this.agentMessages.set(params.itemId, text);
        return text.trim()
          ? [{ ...this.message(params.itemId, "agent", text, false), format: "RichMarkdown" }]
          : [];
      }
      case "item/reasoning/summaryTextDelta": {
        const text = (this.reasoning.get(params.itemId) ?? "") + params.delta;
        this.reasoning.set(params.itemId, text);
        return text.trim() ? [this.message(params.itemId, "reasoning", `💭 ${preview(text, 1_000)}`, false)] : [];
      }
      case "item/started":
        return this.consumeItem(params.item, false);
      case "item/completed":
        return this.consumeItem(params.item, true);
      case "turn/plan/updated": {
        const text = renderPlan(params.plan, params.explanation);
        return text ? [this.message("turn-plan", "plan", text, false)] : [];
      }
      case "turn/diff/updated":
        this.diff = params.diff;
        return [];
      case "thread/tokenUsage/updated":
        this.tokenUsage = params.tokenUsage;
        return [];
      case "error":
        return [this.message(`error:${Date.now()}`, "error", `❌ ${preview(params.error.message, 1_000)}`, true)];
      case "turn/completed": {
        this.turnId = params.turn.id;
        const updates = params.turn.items.flatMap((item) => this.consumeItem(item, true));
        if (params.turn.error) {
          updates.push(this.message(`turn-error:${params.turn.id}`, "error", `❌ ${preview(params.turn.error.message, 1_000)}`, true));
        }
        return updates;
      }
      default:
        return [];
    }
  }

  private consumeItem(item: ThreadItem, completed: boolean): TurnMessageUpdate[] {
    if (item.type === "agentMessage") {
      this.agentMessages.set(item.id, item.text);
      return item.text.trim()
        ? [{ ...this.message(item.id, "agent", item.text, completed), format: "RichMarkdown" }]
        : [];
    }
    if (item.type === "reasoning") {
      const summary = item.summary.join("\n");
      if (!summary) return [];
      this.reasoning.set(item.id, summary);
      return [this.message(item.id, "reasoning", `💭 ${preview(summary, 1_000)}`, completed)];
    }
    if (item.type === "commandExecution") {
      return [{
        ...this.message(item.id, "command", markdownCode(item.command), completed),
        format: "MarkdownV2",
      }];
    }
    if (item.type === "fileChange") {
      const count = item.changes.length;
      return [this.message(item.id, "files", `✏️ ${count} ${count === 1 ? "file" : "files"}`, completed)];
    }
    const name = toolName(item);
    if (name && "id" in item) {
      return [this.message(item.id, "tool", `${toolFailed(item) ? "❌" : "🔧"} ${name}`, completed)];
    }
    return [];
  }

  private message(
    key: string,
    kind: TurnMessageKind,
    text: string,
    completed: boolean,
  ): TurnMessageUpdate {
    return { key: `${kind}:${key}`, kind, text: clean(text).trim(), completed };
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
