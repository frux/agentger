import { AppServerClient } from "./app-server/client.js";
import { AppServerSupervisor } from "./app-server/process.js";
import { loadConfig } from "./config.js";
import { BridgeDatabase } from "./db.js";
import { logger } from "./logger.js";
import { ProjectResolver } from "./projects.js";
import { SessionManager } from "./sessions/manager.js";
import { ApprovalManager } from "./telegram/approvals.js";
import { TelegramApi } from "./telegram/api.js";
import { TelegramBot } from "./telegram/bot.js";
import { TelegramCommands } from "./telegram/commands.js";
import { TopicRouter } from "./telegram/router.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new BridgeDatabase(config.databasePath);
  const projects = new ProjectResolver(db, config.allowedProjectRoots);
  for (const project of config.projects) db.upsertProject(project.name, await projects.validate(project.workingDirectory));
  for (const topic of config.reservedTopics) db.reserveTopic(topic.chatId, topic.threadId, topic.purpose);

  const supervisor = new AppServerSupervisor({
    codexBinary: config.codexBinary,
    requestTimeoutMs: config.rpcTimeoutMs,
    logger,
  });
  const client = new AppServerClient(supervisor, {
    approvalPolicy: config.codexApprovalPolicy,
    sandbox: config.codexSandbox,
  });
  const sessions = new SessionManager(client, db);
  const telegram = new TelegramApi(config.telegramBotToken, logger);
  const router = new TopicRouter(db);
  const approvals = new ApprovalManager(
    telegram,
    db,
    sessions,
    config.allowedUserIds,
    config.approvalTimeoutMs,
  );
  client.setServerRequestHandler(approvals.handleServerRequest);
  client.onDown(() => approvals.cancelAll());
  const commands = new TelegramCommands(telegram, db, projects, router, client, sessions);
  const bot = new TelegramBot(telegram, commands, approvals, router, sessions, {
    allowedUserIds: config.allowedUserIds,
    longPollSeconds: config.telegramLongPollSeconds,
    streamUpdateIntervalMs: config.streamUpdateIntervalMs,
    logger,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    bot.stop();
    approvals.cancelAll();
    await client.stop();
    db.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await client.start();
  await bot.run();
  if (!shuttingDown) await shutdown("bot-stopped");
}

main().catch((error) => {
  logger.error("Fatal startup error", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exitCode = 1;
});
