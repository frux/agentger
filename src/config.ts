import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { AskForApproval } from "./app-server/generated/v2/AskForApproval.js";
import type { SandboxMode } from "./app-server/generated/v2/SandboxMode.js";

export type ProjectSeed = { name: string; workingDirectory: string };
export type ReservedTopicSeed = { chatId: number; threadId: number; purpose: string };

export interface Config {
  telegramBotToken: string;
  allowedUserIds: Set<number>;
  databasePath: string;
  allowedProjectRoots: string[];
  projects: ProjectSeed[];
  defaultProject: string | null;
  reservedTopics: ReservedTopicSeed[];
  codexBinary: string;
  codexApprovalPolicy: AskForApproval;
  codexSandbox: SandboxMode;
  rpcTimeoutMs: number;
  approvalTimeoutMs: number;
  streamUpdateIntervalMs: number;
  telegramLongPollSeconds: number;
}

export function loadEnvFile(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || process.env[key] !== undefined) continue;
    const value = rawValue?.trim() ?? "";
    process.env[key] = ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseIds(raw: string, name: string): Set<number> {
  const ids = raw.split(",").map((part) => Number(part.trim()));
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id))) {
    throw new Error(`${name} must be a comma-separated list of integer IDs`);
  }
  return new Set(ids);
}

function parseRoots(raw: string): string[] {
  return raw.split(",").map((part) => {
    const path = part.trim();
    if (!isAbsolute(path)) throw new Error(`ALLOWED_PROJECT_ROOTS entry is not absolute: ${path}`);
    const canonical = realpathSync(path);
    if (canonical === "/") throw new Error("ALLOWED_PROJECT_ROOTS must never contain /");
    return canonical;
  });
}

function parseProjects(raw: string | undefined): ProjectSeed[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid PROJECTS entry: ${entry}`);
    const name = entry.slice(0, separator).trim();
    const workingDirectory = entry.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) || !isAbsolute(workingDirectory)) {
      throw new Error(`Invalid PROJECTS entry: ${entry}`);
    }
    return { name, workingDirectory };
  });
}

function parseReservedTopics(raw: string | undefined): ReservedTopicSeed[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((entry) => {
    const [chatRaw, threadRaw, ...purposeParts] = entry.split(":");
    const chatId = Number(chatRaw);
    const threadId = Number(threadRaw);
    const purpose = purposeParts.join(":").trim();
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(threadId) || !purpose) {
      throw new Error(`Invalid RESERVED_TOPICS entry: ${entry}`);
    }
    return { chatId, threadId, purpose };
  });
}

function parseApprovalPolicy(value: string | undefined): AskForApproval {
  const policy = value ?? "on-request";
  if (policy === "untrusted" || policy === "on-request" || policy === "never") return policy;
  throw new Error("CODEX_APPROVAL_POLICY must be untrusted, on-request, or never");
}

function parseSandbox(value: string | undefined): SandboxMode {
  const sandbox = value ?? "workspace-write";
  if (sandbox === "read-only" || sandbox === "workspace-write" || sandbox === "danger-full-access") return sandbox;
  throw new Error("CODEX_SANDBOX must be read-only, workspace-write, or danger-full-access");
}

export function loadConfig(): Config {
  loadEnvFile();
  const config: Config = {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: parseIds(required("TELEGRAM_ALLOWED_USER_IDS"), "TELEGRAM_ALLOWED_USER_IDS"),
    databasePath: resolve(process.env.DATABASE_PATH ?? "./data/bot.sqlite"),
    allowedProjectRoots: parseRoots(required("ALLOWED_PROJECT_ROOTS")),
    projects: parseProjects(process.env.PROJECTS),
    defaultProject: process.env.DEFAULT_PROJECT?.trim() || null,
    reservedTopics: parseReservedTopics(process.env.RESERVED_TOPICS),
    codexBinary: process.env.CODEX_BINARY?.trim() || "codex",
    codexApprovalPolicy: parseApprovalPolicy(process.env.CODEX_APPROVAL_POLICY),
    codexSandbox: parseSandbox(process.env.CODEX_SANDBOX),
    rpcTimeoutMs: positiveInt("RPC_TIMEOUT_MS", 30_000),
    approvalTimeoutMs: positiveInt("APPROVAL_TIMEOUT_MS", 10 * 60_000),
    streamUpdateIntervalMs: positiveInt("STREAM_UPDATE_INTERVAL_MS", 750),
    telegramLongPollSeconds: positiveInt("TELEGRAM_LONG_POLL_SECONDS", 45),
  };
  const ssh = resolve(homedir(), ".ssh");
  const protectedRoots = ["/", "/etc", ssh].map((path) => existsSync(path) ? realpathSync(path) : path);
  if (config.allowedProjectRoots.some((root) => protectedRoots.some((protectedRoot) =>
    root === protectedRoot || (protectedRoot !== "/" && root.startsWith(`${protectedRoot}/`))
  ))) {
    throw new Error("ALLOWED_PROJECT_ROOTS must not contain /, /etc, or ~/.ssh");
  }
  return config;
}
