import type { ServerNotification } from "./generated/ServerNotification.js";
import type { ServerRequest } from "./generated/ServerRequest.js";
import type { ThreadListParams } from "./generated/v2/ThreadListParams.js";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse.js";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import type { TurnSteerResponse } from "./generated/v2/TurnSteerResponse.js";
import type { AskForApproval } from "./generated/v2/AskForApproval.js";
import type { SandboxMode } from "./generated/v2/SandboxMode.js";
import { AppServerSupervisor } from "./process.js";
import { RpcError, type ServerRequestHandler } from "./rpc.js";

export interface AppServerClientOptions {
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
}

export class AppServerClient {
  readonly approvalPolicy: AskForApproval;
  readonly sandbox: SandboxMode;

  constructor(
    readonly supervisor: AppServerSupervisor,
    options: AppServerClientOptions = {},
  ) {
    this.approvalPolicy = options.approvalPolicy ?? "on-request";
    this.sandbox = options.sandbox ?? "workspace-write";
  }

  get generation(): number {
    return this.supervisor.generation;
  }

  get health(): AppServerSupervisor["health"] {
    return this.supervisor.health;
  }

  start(): Promise<void> {
    return this.supervisor.start();
  }

  stop(): Promise<void> {
    return this.supervisor.stop();
  }

  onNotification(listener: (notification: ServerNotification) => void): () => void {
    this.supervisor.on("notification", listener);
    return () => this.supervisor.off("notification", listener);
  }

  onReady(listener: (generation: number) => void): () => void {
    this.supervisor.on("ready", listener);
    return () => this.supervisor.off("ready", listener);
  }

  onDown(listener: (error: Error) => void): () => void {
    this.supervisor.on("down", listener);
    return () => this.supervisor.off("down", listener);
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.supervisor.setServerRequestHandler(handler);
  }

  startThread(cwd: string): Promise<ThreadStartResponse> {
    return this.supervisor.request("thread/start", {
      cwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
    });
  }

  resumeThread(threadId: string, cwd?: string): Promise<ThreadResumeResponse> {
    return this.idempotent(() => this.supervisor.request("thread/resume", {
      threadId,
      ...(cwd === undefined ? {} : { cwd }),
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
    }));
  }

  readThread(threadId: string, includeTurns = true): Promise<ThreadReadResponse> {
    return this.idempotent(() => this.supervisor.request("thread/read", { threadId, includeTurns }));
  }

  listThreads(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    return this.idempotent(() => this.supervisor.request("thread/list", params));
  }

  startTurn(threadId: string, text: string, clientUserMessageId?: string): Promise<TurnStartResponse> {
    return this.supervisor.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
    });
  }

  steerTurn(threadId: string, text: string, clientUserMessageId?: string): Promise<TurnSteerResponse> {
    return this.supervisor.request("turn/steer", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.supervisor.request("turn/interrupt", { threadId, turnId });
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    await this.idempotent(() => this.supervisor.request("thread/unsubscribe", { threadId }));
  }

  private async idempotent<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const retryable = error instanceof RpcError && error.code === -32001;
        if (!retryable || attempt === attempts - 1) throw error;
        const delay = Math.round(200 * 2 ** attempt * (0.75 + Math.random() * 0.5));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }
}

export type { ServerNotification, ServerRequest };
