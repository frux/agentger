import type { ServerNotification } from "../app-server/generated/ServerNotification.js";
import type { Thread } from "../app-server/generated/v2/Thread.js";
import type { ThreadTokenUsage } from "../app-server/generated/v2/ThreadTokenUsage.js";
import type { AppServerClient } from "../app-server/client.js";
import type { ThreadReadResponse } from "../app-server/generated/v2/ThreadReadResponse.js";
import type { ThreadResumeResponse } from "../app-server/generated/v2/ThreadResumeResponse.js";
import type { TurnStartResponse } from "../app-server/generated/v2/TurnStartResponse.js";
import type { BridgeDatabase, TopicBinding } from "../db.js";

export interface TurnSink {
  onProcessingStarted?(): void;
  onInputAccepted?(): void;
  setWaitingForUser?(waiting: boolean): void;
  onNotification(notification: ServerNotification): void;
  onError(error: unknown): void | Promise<void>;
}

export interface SessionClient {
  readonly generation: number;
  onNotification(listener: (notification: ServerNotification) => void): () => void;
  onReady(listener: (generation: number) => void): () => void;
  onDown(listener: (error: Error) => void): () => void;
  resumeThread(threadId: string, cwd?: string): Promise<ThreadResumeResponse>;
  startTurn(threadId: string, text: string, clientUserMessageId?: string): Promise<TurnStartResponse>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  readThread(threadId: string, includeTurns?: boolean): Promise<ThreadReadResponse>;
}

export interface SessionSnapshot {
  status: "idle" | "working" | "waiting approval" | "failed";
  turnId: string | null;
  model: string | null;
  tokenUsage: ThreadTokenUsage | null;
  lastError: string | null;
  queueLength: number;
}

type ActiveTurn = {
  turnId: string | null;
  sink: TurnSink;
  resolve: () => void;
  reject: (error: Error) => void;
  completion: Promise<void>;
};

type RuntimeState = {
  loadedGeneration: number;
  status: SessionSnapshot["status"];
  model: string | null;
  tokenUsage: ThreadTokenUsage | null;
  lastError: string | null;
  lastDiff: string;
  active: ActiveTurn | null;
  queued: number;
};

function deferred(): Pick<ActiveTurn, "completion" | "resolve" | "reject"> {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { completion, resolve, reject };
}

function notificationThreadId(notification: ServerNotification): string | null {
  const params = notification.params as unknown as Record<string, unknown>;
  return typeof params.threadId === "string" ? params.threadId : null;
}

export class SessionManager {
  private readonly states = new Map<string, RuntimeState>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly client: SessionClient,
    private readonly db: BridgeDatabase,
  ) {
    client.onNotification((notification) => this.handleNotification(notification));
    client.onReady(() => {
      for (const state of this.states.values()) state.loadedGeneration = 0;
    });
    client.onDown((error) => this.handleDown(error));
  }

  registerLoaded(threadId: string, model: string): void {
    const state = this.state(threadId);
    state.loadedGeneration = this.client.generation;
    state.model = model;
    state.status = "idle";
    state.lastError = null;
  }

  enqueue(binding: TopicBinding, text: string, clientUserMessageId: string, sink: TurnSink): Promise<void> {
    const threadId = binding.codexThreadId;
    const state = this.state(threadId);
    state.queued += 1;
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      state.queued = Math.max(0, state.queued - 1);
      await this.runTurn(binding, text, clientUserMessageId, sink);
    });
    this.queues.set(threadId, task);
    void task.finally(() => {
      if (this.queues.get(threadId) === task) this.queues.delete(threadId);
    }).catch(() => undefined);
    return task;
  }

  async ensureLoaded(binding: TopicBinding): Promise<void> {
    const state = this.state(binding.codexThreadId);
    if (state.loadedGeneration === this.client.generation && this.client.generation > 0) return;
    try {
      const resumed = await this.client.resumeThread(binding.codexThreadId, binding.workingDirectory);
      state.loadedGeneration = this.client.generation;
      state.model = resumed.model;
      state.status = resumed.thread.status.type === "active" ? "working" : "idle";
      state.lastError = null;
      this.db.markBindingHealthy(binding.telegramChatId, binding.telegramThreadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.status = "failed";
      state.lastError = message;
      if (/not found|no rollout|unknown thread|does not exist/i.test(message)) {
        this.db.markBindingBroken(binding.telegramChatId, binding.telegramThreadId, message);
      }
      throw error;
    }
  }

  async interrupt(threadId: string): Promise<boolean> {
    const active = this.states.get(threadId)?.active;
    if (!active?.turnId) return false;
    await this.client.interruptTurn(threadId, active.turnId);
    return true;
  }

  snapshot(threadId: string): SessionSnapshot {
    const state = this.state(threadId);
    return {
      status: state.status,
      turnId: state.active?.turnId ?? null,
      model: state.model,
      tokenUsage: state.tokenUsage,
      lastError: state.lastError,
      queueLength: state.queued,
    };
  }

  getDiff(threadId: string): string {
    return this.state(threadId).lastDiff;
  }

  async history(threadId: string): Promise<Thread> {
    return (await this.client.readThread(threadId, true)).thread;
  }

  setWaitingApproval(threadId: string, waiting: boolean): void {
    const state = this.state(threadId);
    if (state.active) {
      state.status = waiting ? "waiting approval" : "working";
      state.active.sink.setWaitingForUser?.(waiting);
    }
  }

  detach(threadId: string): void {
    const state = this.states.get(threadId);
    if (!state?.active && state?.queued === 0) this.states.delete(threadId);
  }

  private async runTurn(binding: TopicBinding, text: string, clientUserMessageId: string, sink: TurnSink): Promise<void> {
    const threadId = binding.codexThreadId;
    const state = this.state(threadId);
    try {
      sink.onProcessingStarted?.();
      await this.ensureLoaded(binding);
      const wait = deferred();
      const active: ActiveTurn = { turnId: null, sink, ...wait };
      state.active = active;
      state.status = "working";
      state.lastError = null;
      const response = await this.client.startTurn(threadId, text, clientUserMessageId);
      active.turnId = response.turn.id;
      sink.onInputAccepted?.();
      await active.completion;
    } catch (error) {
      state.status = "failed";
      state.lastError = error instanceof Error ? error.message : String(error);
      await sink.onError(error);
      throw error;
    } finally {
      if (state.active?.sink === sink) state.active = null;
      if (state.status !== "failed") state.status = "idle";
    }
  }

  private handleNotification(notification: ServerNotification): void {
    const threadId = notificationThreadId(notification);
    if (!threadId) return;
    const state = this.state(threadId);
    if (notification.method === "turn/diff/updated") state.lastDiff = notification.params.diff;
    if (notification.method === "thread/tokenUsage/updated") state.tokenUsage = notification.params.tokenUsage;
    if (notification.method === "turn/started" && state.active && !state.active.turnId) {
      state.active.turnId = notification.params.turn.id;
    }
    const active = state.active;
    if (!active) return;
    const params = notification.params as unknown as Record<string, unknown>;
    const eventTurnId = typeof params.turnId === "string"
      ? params.turnId
      : params.turn && typeof params.turn === "object" && typeof (params.turn as Record<string, unknown>).id === "string"
        ? (params.turn as Record<string, unknown>).id as string
        : null;
    if (eventTurnId && active.turnId && eventTurnId !== active.turnId) return;
    active.sink.onNotification(notification);
    if (notification.method === "turn/completed") {
      state.status = notification.params.turn.status === "failed" ? "failed" : "idle";
      state.lastError = notification.params.turn.error?.message ?? null;
      active.resolve();
    }
  }

  private handleDown(error: Error): void {
    for (const state of this.states.values()) {
      state.loadedGeneration = 0;
      if (state.active) {
        state.status = "failed";
        state.lastError = error.message;
        state.active.reject(error);
      }
    }
  }

  private state(threadId: string): RuntimeState {
    let state = this.states.get(threadId);
    if (!state) {
      state = {
        loadedGeneration: 0,
        status: "idle",
        model: null,
        tokenUsage: null,
        lastError: null,
        lastDiff: "",
        active: null,
        queued: 0,
      };
      this.states.set(threadId, state);
    }
    return state;
  }
}
