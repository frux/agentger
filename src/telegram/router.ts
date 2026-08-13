import type { BridgeDatabase, TopicBinding } from "../db.js";

export type TopicRoute =
  | { type: "not-topic" }
  | { type: "unknown" }
  | { type: "reserved"; purpose: string }
  | { type: "codex"; binding: TopicBinding };

export class TopicRouter {
  constructor(private readonly db: BridgeDatabase) {}

  route(chatId: number, threadId: number | undefined): TopicRoute {
    if (threadId === undefined) return { type: "not-topic" };
    const reserved = this.db.getReserved(chatId, threadId);
    if (reserved) return { type: "reserved", purpose: reserved.purpose };
    const binding = this.db.getBinding(chatId, threadId);
    if (binding) return { type: "codex", binding };
    return { type: "unknown" };
  }
}
