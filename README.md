# Telegram ↔ Codex bridge

A personal, long-running Telegram UI for Codex. It launches `codex app-server --stdio` as a supervised child process and implements the newline-delimited, bidirectional app-server protocol directly—without `@openai/codex-sdk`.

The core isolation rule is strict:

> A Telegram topic is a Codex topic only when its `(chat_id, message_thread_id)` is explicitly present in `codex_topics`.

Ordinary messages in unknown or reserved topics are ignored. Only `/codex-init` and `/codex-attach` create bindings.

## What is implemented

- app-server v2 `Thread → Turn → Items`, generated protocol types, and the required `initialize` / `initialized` handshake;
- stdio JSONL RPC with concurrent correlation, timeouts, notifications, server requests, pending-request rejection, supervised restart, exponential backoff, and overload retry for idempotent calls;
- SQLite bindings, reserved report topics, project aliases, lazy `thread/resume`, `thread/read`, and a typed `thread/list` diagnostic method;
- canonical `realpath` validation against `ALLOWED_PROJECT_ROOTS`, including symlink-escape protection;
- per-thread FIFO turns while different threads run concurrently; `turn/steer` is exposed in the typed client for a future queue/steer policy switch;
- throttled Telegram edits for agent output, safe reasoning summaries, plans, commands, file counts, MCP calls, final messages, and Telegram-size splitting;
- current command/file approval requests (v2 plus legacy compatibility) with short opaque callback IDs, Allow/Deny buttons, timeout, and duplicate-callback handling;
- interrupt, status, diff, history, binding close, app-server recovery, and broken-binding diagnostics.

No Git assumptions or operations are used. Codex receives only the selected `cwd`; the bridge does not create branches or worktrees.

The protocol implementation was checked against `codex-rs/app-server/README.md` and generated with the installed Codex version. The upstream README describes the [wire protocol and generated schemas](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server/README.md#protocol), [thread/turn lifecycle](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server/README.md#lifecycle-overview), and [approval flow](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/app-server/README.md#approvals).

## Requirements

- Linux VM with Node.js 22.5+ (the bridge uses built-in `node:sqlite`);
- Codex CLI installed and authenticated for the service account;
- a Telegram supergroup with Topics enabled;
- a Telegram bot token and the numeric ID of the only allowed user (or a short allowlist).

Verify Codex first as the same Linux user that will run the service:

```sh
codex --version
codex login status
codex app-server --help
```

## Install

```sh
cd /opt/telegram-codex
npm ci
npm run generate:protocol
npm run build
npm test
```

`npm run generate:protocol` deliberately uses the installed CLI. Whenever Codex is upgraded, regenerate types and rebuild before restarting the service. A method/parameter mismatch during initialization is treated as a fatal, clearly logged compatibility error instead of a restart loop.

Copy `.env.example` to a root-readable service environment file:

```sh
sudo install -m 600 .env.example /etc/telegram-codex.env
sudoedit /etc/telegram-codex.env
```

Important settings:

- `TELEGRAM_ALLOWED_USER_IDS`: comma-separated numeric Telegram user IDs;
- `ALLOWED_PROJECT_ROOTS`: existing absolute directories; `/`, `/etc`, and `~/.ssh` are rejected;
- `PROJECTS`: `alias=/absolute/cwd` pairs that seed the SQLite `projects` table;
- `RESERVED_TOPICS`: `chat_id:thread_id:purpose` entries for existing report topics;
- `CODEX_BINARY`: use an absolute path under systemd if Codex is not in the service PATH.

The bot token is used only to construct Telegram API requests and is never logged. Do not place secrets in command-line arguments or commit the environment file.

## Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and save its token.
2. Add the bot to the target supergroup.
3. Enable Topics/Forum mode for the group.
4. Disable BotFather privacy mode for this bot, or otherwise give it permission to receive ordinary topic messages. Commands alone are not sufficient for the remote UI.
5. Put your numeric user ID in `TELEGRAM_ALLOWED_USER_IDS`.
6. Record all existing report topic IDs in `RESERVED_TOPICS`. Topic IDs are Telegram `message_thread_id` values, not visible topic names.

On startup, `PROJECTS` and `RESERVED_TOPICS` are idempotently upserted. They can also be administered directly in SQLite while the service is stopped:

```sql
insert into projects(name, working_directory)
values ('frux', '/home/codex/projects/frux');

insert into reserved_topics(telegram_chat_id, telegram_thread_id, purpose)
values (-1001234567890, 10, 'daily report');
```

## Run with systemd

Adjust `User`, `Group`, paths, and `ExecStart` in `deploy/telegram-codex.service`, then:

```sh
sudo install -m 644 deploy/telegram-codex.service /etc/systemd/system/telegram-codex.service
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-codex
sudo systemctl status telegram-codex
journalctl -u telegram-codex -f
```

The service is independent of SSH and a laptop. systemd restarts the bridge; the bridge itself restarts only its app-server child and repeats the handshake.

## Commands

Inside a new, unreserved Telegram topic:

```text
/codex-init frux
```

Or attach a persisted Codex thread:

```text
/codex-attach <thread-id>
```

Available commands:

- `/codex-status` — thread, cwd, runtime state, turn, model, queue, token use, binding health, and app-server health;
- `/codex-stop` — calls `turn/interrupt` for the active turn only;
- `/codex-diff` — latest aggregated `turn/diff/updated` snapshot;
- `/codex-history` — persisted history from `thread/read`;
- `/codex-close` — deletes only the Telegram binding; it never archives or deletes the Codex thread;
- `/projects` — configured aliases;
- `/codex-help` — compact help.

After initialization, send ordinary text in that same topic. `clientUserMessageId` is stored as `tg:<chat>:<topic>:<message>` for stable correlation. A second message waits in the thread FIFO. Other bound topics can execute concurrently.

## Recovery semantics

Bindings are durable in SQLite; transient stream notifications are not treated as the source of truth. After restart, no thread is created automatically. The first access performs `thread/resume`; `/codex-history` performs `thread/read`. Missing persisted threads mark the binding broken and are reported rather than silently replaced.

An app-server crash rejects all in-flight RPC promises, cancels displayed approvals, and triggers a jittered exponential restart. `turn/start` is never retried automatically because acceptance may be ambiguous. Read-only/idempotent calls may retry only the documented `-32001 Server overloaded` response.

## Tests

```sh
npm test
```

The unit suite uses fake stdio/Telegram transports and covers RPC correlation, server requests, unknown notifications, process death, handshake ordering, topic isolation, queue serialization, approval allow/deny/duplicates, interrupt, cwd and symlink validation, message splitting, and streaming debounce.

The real app-server smoke test is opt-in because it uses the installed Codex authentication and performs a model turn:

```sh
TELECODEX_INTEGRATION=1 npm test
```

It starts app-server, initializes, starts a thread and turn, observes streaming and completion, then verifies the persisted turn with `thread/read`.
