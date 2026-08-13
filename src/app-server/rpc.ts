import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RequestId } from "./generated/RequestId.js";
import type { ServerNotification } from "./generated/ServerNotification.js";
import type { ServerRequest } from "./generated/ServerRequest.js";
import type { Logger } from "../logger.js";
import { nullLogger } from "../logger.js";

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
};

type WireRequest = { id: RequestId; method: string; params?: unknown };
type WireNotification = { method: string; params?: unknown };
type WireResponse = { id: RequestId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcConnectionClosedError extends Error {
  constructor(message = "codex app-server connection closed") {
    super(message);
    this.name = "RpcConnectionClosedError";
  }
}

export type ServerRequestHandler = (request: ServerRequest) => Promise<unknown>;

export interface JsonRpcClientOptions {
  defaultTimeoutMs?: number;
  logger?: Logger;
  requestHandler?: ServerRequestHandler;
}

/** Minimal app-server JSON-RPC client. The wire intentionally omits jsonrpc. */
export class JsonRpcClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly lines: Interface;
  private closed = false;
  private requestHandler: ServerRequestHandler;
  private readonly defaultTimeoutMs: number;
  private readonly log: Logger;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    options: JsonRpcClientOptions = {},
  ) {
    super();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.log = options.logger ?? nullLogger;
    this.requestHandler = options.requestHandler ?? (async (request) => {
      throw new RpcError(`Unsupported server request: ${request.method}`, -32601);
    });
    this.lines = createInterface({ input, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    input.on("error", (error) => this.close(error));
    output.on("error", (error) => this.close(error));
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.requestHandler = handler;
  }

  request<Result>(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<Result> {
    if (this.closed) return Promise.reject(new RpcConnectionClosedError());
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`RPC ${method} timed out after ${timeoutMs}ms`, -32000));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
        method,
      });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) throw new RpcConnectionClosedError();
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  close(reason: unknown = new RpcConnectionClosedError()): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    const error = reason instanceof Error ? reason : new RpcConnectionClosedError(String(reason));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private write(message: WireRequest | WireNotification | WireResponse): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.log.warn("Ignoring invalid app-server JSON", { error: String(error), preview: line.slice(0, 200) });
      this.emit("protocolError", error);
      return;
    }
    if (!message || typeof message !== "object") {
      this.emit("protocolError", new Error("RPC message is not an object"));
      return;
    }
    const record = message as Record<string, unknown>;
    if ("method" in record && typeof record.method === "string") {
      if ("id" in record) void this.handleServerRequest(record as unknown as WireRequest);
      else this.handleNotification(record as unknown as WireNotification);
      return;
    }
    if ("id" in record) this.handleResponse(record as unknown as WireResponse);
    else this.emit("protocolError", new Error("Unrecognized RPC message"));
  }

  private handleResponse(response: WireResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.log.debug("Ignoring response for unknown request", { requestId: response.id });
      return;
    }
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new RpcError(response.error.message, response.error.code, response.error.data));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleNotification(notification: WireNotification): void {
    this.emit("notification", notification as ServerNotification);
  }

  private async handleServerRequest(request: WireRequest): Promise<void> {
    try {
      const result = await this.requestHandler(request as ServerRequest);
      if (!this.closed) this.write({ id: request.id, result });
    } catch (error) {
      const rpcError = error instanceof RpcError ? error : new RpcError(String(error), -32603);
      if (!this.closed) {
        this.write({ id: request.id, error: { code: rpcError.code, message: rpcError.message, data: rpcError.data } });
      }
    }
  }
}
