import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface TopicKey {
  telegramChatId: number;
  telegramThreadId: number;
}

export interface TopicBinding extends TopicKey {
  codexThreadId: string;
  workingDirectory: string;
  title: string | null;
  createdAt: string;
  brokenReason: string | null;
}

export interface ReservedTopic extends TopicKey {
  purpose: string;
}

type BindingRow = {
  telegram_chat_id: number;
  telegram_thread_id: number;
  codex_thread_id: string;
  working_directory: string;
  title: string | null;
  created_at: string;
  broken_reason: string | null;
};

export class TopicAlreadyBoundError extends Error {}
export class TopicReservedError extends Error {}
export class ThreadAlreadyBoundError extends Error {}

function bindingFromRow(row: BindingRow): TopicBinding {
  return {
    telegramChatId: row.telegram_chat_id,
    telegramThreadId: row.telegram_thread_id,
    codexThreadId: row.codex_thread_id,
    workingDirectory: row.working_directory,
    title: row.title,
    createdAt: row.created_at,
    brokenReason: row.broken_reason,
  };
}

export class BridgeDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS codex_topics (
        telegram_chat_id INTEGER NOT NULL,
        telegram_thread_id INTEGER NOT NULL,
        codex_thread_id TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (telegram_chat_id, telegram_thread_id)
      );
      CREATE TABLE IF NOT EXISTS reserved_topics (
        telegram_chat_id INTEGER NOT NULL,
        telegram_thread_id INTEGER NOT NULL,
        purpose TEXT NOT NULL,
        PRIMARY KEY (telegram_chat_id, telegram_thread_id)
      );
      CREATE TABLE IF NOT EXISTS projects (
        name TEXT PRIMARY KEY,
        working_directory TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_topic_health (
        telegram_chat_id INTEGER NOT NULL,
        telegram_thread_id INTEGER NOT NULL,
        broken_reason TEXT,
        checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (telegram_chat_id, telegram_thread_id),
        FOREIGN KEY (telegram_chat_id, telegram_thread_id)
          REFERENCES codex_topics (telegram_chat_id, telegram_thread_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS codex_topics_thread_idx ON codex_topics(codex_thread_id);
    `);
  }

  getBinding(chatId: number, threadId: number): TopicBinding | null {
    const row = this.sqlite.prepare(`
      SELECT c.*, h.broken_reason
      FROM codex_topics c
      LEFT JOIN codex_topic_health h USING (telegram_chat_id, telegram_thread_id)
      WHERE c.telegram_chat_id = ? AND c.telegram_thread_id = ?
    `).get(chatId, threadId) as BindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  getBindingByThread(codexThreadId: string): TopicBinding | null {
    const row = this.sqlite.prepare(`
      SELECT c.*, h.broken_reason
      FROM codex_topics c
      LEFT JOIN codex_topic_health h USING (telegram_chat_id, telegram_thread_id)
      WHERE c.codex_thread_id = ?
      ORDER BY c.created_at ASC LIMIT 1
    `).get(codexThreadId) as BindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  listBindings(): TopicBinding[] {
    return (this.sqlite.prepare(`
      SELECT c.*, h.broken_reason
      FROM codex_topics c
      LEFT JOIN codex_topic_health h USING (telegram_chat_id, telegram_thread_id)
      ORDER BY c.created_at ASC
    `).all() as unknown as BindingRow[]).map(bindingFromRow);
  }

  createBinding(binding: Omit<TopicBinding, "createdAt" | "brokenReason">): TopicBinding {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (this.getReserved(binding.telegramChatId, binding.telegramThreadId)) throw new TopicReservedError("Topic is reserved");
      if (this.getBinding(binding.telegramChatId, binding.telegramThreadId)) throw new TopicAlreadyBoundError("Topic already has a binding");
      if (this.getBindingByThread(binding.codexThreadId)) throw new ThreadAlreadyBoundError("Codex thread is already bound");
      this.sqlite.prepare(`
        INSERT INTO codex_topics
          (telegram_chat_id, telegram_thread_id, codex_thread_id, working_directory, title)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        binding.telegramChatId,
        binding.telegramThreadId,
        binding.codexThreadId,
        binding.workingDirectory,
        binding.title,
      );
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    const created = this.getBinding(binding.telegramChatId, binding.telegramThreadId);
    if (!created) throw new Error("Failed to read newly created topic binding");
    return created;
  }

  deleteBinding(chatId: number, threadId: number): boolean {
    return this.sqlite.prepare(
      "DELETE FROM codex_topics WHERE telegram_chat_id = ? AND telegram_thread_id = ?",
    ).run(chatId, threadId).changes > 0;
  }

  markBindingBroken(chatId: number, threadId: number, reason: string): void {
    this.sqlite.prepare(`
      INSERT INTO codex_topic_health (telegram_chat_id, telegram_thread_id, broken_reason, checked_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (telegram_chat_id, telegram_thread_id)
      DO UPDATE SET broken_reason = excluded.broken_reason, checked_at = CURRENT_TIMESTAMP
    `).run(chatId, threadId, reason.slice(0, 1_000));
  }

  markBindingHealthy(chatId: number, threadId: number): void {
    this.sqlite.prepare(`
      INSERT INTO codex_topic_health (telegram_chat_id, telegram_thread_id, broken_reason, checked_at)
      VALUES (?, ?, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT (telegram_chat_id, telegram_thread_id)
      DO UPDATE SET broken_reason = NULL, checked_at = CURRENT_TIMESTAMP
    `).run(chatId, threadId);
  }

  getReserved(chatId: number, threadId: number): ReservedTopic | null {
    const row = this.sqlite.prepare(`
      SELECT telegram_chat_id, telegram_thread_id, purpose FROM reserved_topics
      WHERE telegram_chat_id = ? AND telegram_thread_id = ?
    `).get(chatId, threadId) as { telegram_chat_id: number; telegram_thread_id: number; purpose: string } | undefined;
    return row ? { telegramChatId: row.telegram_chat_id, telegramThreadId: row.telegram_thread_id, purpose: row.purpose } : null;
  }

  reserveTopic(chatId: number, threadId: number, purpose: string): void {
    if (this.getBinding(chatId, threadId)) {
      throw new TopicAlreadyBoundError("Cannot reserve a topic that already has a Codex binding");
    }
    this.sqlite.prepare(`
      INSERT INTO reserved_topics (telegram_chat_id, telegram_thread_id, purpose)
      VALUES (?, ?, ?)
      ON CONFLICT (telegram_chat_id, telegram_thread_id) DO UPDATE SET purpose = excluded.purpose
    `).run(chatId, threadId, purpose);
  }

  upsertProject(name: string, workingDirectory: string): void {
    this.sqlite.prepare(`
      INSERT INTO projects (name, working_directory) VALUES (?, ?)
      ON CONFLICT (name) DO UPDATE SET working_directory = excluded.working_directory
    `).run(name, workingDirectory);
  }

  getProject(name: string): { name: string; workingDirectory: string } | null {
    const row = this.sqlite.prepare(
      "SELECT name, working_directory FROM projects WHERE name = ?",
    ).get(name) as { name: string; working_directory: string } | undefined;
    return row ? { name: row.name, workingDirectory: row.working_directory } : null;
  }

  listProjects(): Array<{ name: string; workingDirectory: string }> {
    const rows = this.sqlite.prepare(
      "SELECT name, working_directory FROM projects ORDER BY name",
    ).all() as unknown as Array<{ name: string; working_directory: string }>;
    return rows.map((row) => ({ name: row.name, workingDirectory: row.working_directory }));
  }
}
