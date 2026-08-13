import { EventEmitter } from "node:events";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { InitializeResponse } from "./generated/InitializeResponse.js";
import type { ServerNotification } from "./generated/ServerNotification.js";
import type { ServerRequest } from "./generated/ServerRequest.js";
import { JsonRpcClient, RpcConnectionClosedError, RpcError, type ServerRequestHandler } from "./rpc.js";
import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";

export interface AppServerSupervisorOptions {
  codexBinary?: string;
  requestTimeoutMs?: number;
  restartBaseMs?: number;
  restartMaxMs?: number;
  logger?: Logger;
  random?: () => number;
  spawnProcess?: () => ChildProcessWithoutNullStreams;
  versionResolver?: () => string;
}

type ReadyWaiter = { resolve: () => void; reject: (error: Error) => void };

export class AppServerSupervisor extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rpc: JsonRpcClient | null = null;
  private stopping = false;
  private ready = false;
  private startAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private fatalError: Error | null = null;
  private readonly waiters: ReadyWaiter[] = [];
  private serverRequestHandler: ServerRequestHandler = async (request) => {
    throw new Error(`No handler for server request ${request.method}`);
  };
  private readonly codexBinary: string;
  private readonly requestTimeoutMs: number;
  private readonly restartBaseMs: number;
  private readonly restartMaxMs: number;
  private readonly log: Logger;
  private readonly random: () => number;
  private readonly spawnProcess: (() => ChildProcessWithoutNullStreams) | undefined;
  private readonly versionResolver: (() => string) | undefined;
  generation = 0;
  version = "unknown";
  initializeResponse: InitializeResponse | null = null;

  constructor(options: AppServerSupervisorOptions = {}) {
    super();
    this.codexBinary = options.codexBinary ?? "codex";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.restartBaseMs = options.restartBaseMs ?? 500;
    this.restartMaxMs = options.restartMaxMs ?? 30_000;
    this.log = options.logger ?? defaultLogger;
    this.random = options.random ?? Math.random;
    this.spawnProcess = options.spawnProcess;
    this.versionResolver = options.versionResolver;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    this.stopping = false;
    if (this.fatalError) throw this.fatalError;
    if (!this.child) this.spawnServer();
    await this.whenReady();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.rpc?.close(new RpcConnectionClosedError("app-server supervisor stopped"));
    this.rpc = null;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolve();
        }, 5_000);
        timer.unref?.();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const error = new RpcConnectionClosedError("app-server supervisor stopped");
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
    this.rpc?.setServerRequestHandler(handler);
  }

  async request<Result>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<Result> {
    await this.whenReady();
    const rpc = this.rpc;
    if (!rpc) throw new RpcConnectionClosedError();
    return rpc.request<Result>(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    if (!this.ready || !this.rpc) throw new RpcConnectionClosedError("app-server is not initialized");
    this.rpc.notify(method, params);
  }

  whenReady(): Promise<void> {
    if (this.ready && this.rpc) return Promise.resolve();
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.stopping) return Promise.reject(new RpcConnectionClosedError("app-server supervisor stopped"));
    return new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  get health(): { ready: boolean; pid: number | null; generation: number; restartAttempt: number; version: string } {
    return {
      ready: this.ready,
      pid: this.child?.pid ?? null,
      generation: this.generation,
      restartAttempt: this.startAttempt,
      version: this.version,
    };
  }

  private spawnServer(): void {
    if (this.stopping || this.child) return;
    try {
      this.version = this.versionResolver
        ? this.versionResolver()
        : execFileSync(this.codexBinary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      this.version = "unknown";
    }
    this.log.info("Starting codex app-server", { version: this.version, attempt: this.startAttempt + 1 });
    const child = this.spawnProcess?.() ?? spawn(this.codexBinary, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, LOG_FORMAT: process.env.LOG_FORMAT ?? "json" },
      });
    this.child = child;
    const rpc = new JsonRpcClient(child.stdout, child.stdin, {
      defaultTimeoutMs: this.requestTimeoutMs,
      logger: this.log,
      requestHandler: (request) => this.serverRequestHandler(request),
    });
    this.rpc = rpc;
    rpc.on("notification", (notification: ServerNotification) => this.emit("notification", notification));
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => this.log.info("codex app-server stderr", { line: line.slice(0, 4_000) }));

    let exited = false;
    const down = (error: Error, code: number | null = child.exitCode, signal: NodeJS.Signals | null = child.signalCode) => {
      if (exited) return;
      exited = true;
      stderr.close();
      if (this.child === child) this.child = null;
      if (this.rpc === rpc) this.rpc = null;
      this.ready = false;
      rpc.close(error);
      const logStopped = this.stopping ? this.log.info.bind(this.log) : this.log.error.bind(this.log);
      logStopped("codex app-server stopped", { code, signal, error: error.message });
      this.emit("down", error);
      if (!this.stopping && !this.fatalError) this.scheduleRestart();
    };
    child.once("error", (error) => down(error));
    child.once("exit", (code, signal) => down(new RpcConnectionClosedError(`app-server exited (code=${code}, signal=${signal})`), code, signal));

    void this.initialize(rpc).catch((error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const incompatible = error instanceof RpcError && (error.code === -32601 || error.code === -32602);
      if (incompatible) {
        this.fatalError = new Error(`Incompatible codex app-server protocol (${this.version}): ${normalized.message}`);
        for (const waiter of this.waiters.splice(0)) waiter.reject(this.fatalError);
      }
      this.log.error("app-server initialization failed", { error: normalized.message, incompatible });
      if (child.exitCode === null) child.kill("SIGTERM");
      down(normalized);
    });
  }

  private async initialize(rpc: JsonRpcClient): Promise<void> {
    const response = await rpc.request<InitializeResponse>("initialize", {
      clientInfo: { name: "agentger", title: "Agentger", version: "0.3.0" },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: null,
      },
    });
    rpc.notify("initialized");
    if (this.rpc !== rpc || this.stopping) return;
    this.initializeResponse = response;
    this.ready = true;
    this.startAttempt = 0;
    this.generation += 1;
    this.log.info("codex app-server initialized", {
      generation: this.generation,
      userAgent: response.userAgent,
      platformFamily: response.platformFamily,
      platformOs: response.platformOs,
    });
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
    this.emit("ready", this.generation);
  }

  private scheduleRestart(): void {
    this.startAttempt += 1;
    const base = Math.min(this.restartMaxMs, this.restartBaseMs * 2 ** Math.min(this.startAttempt - 1, 10));
    const delay = Math.round(base * (0.75 + this.random() * 0.5));
    this.log.warn("Scheduling app-server restart", { delayMs: delay, attempt: this.startAttempt });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnServer();
    }, delay);
  }
}
