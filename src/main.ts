import { AppServerClient } from "./app-server/client.js";
import { AppServerSupervisor } from "./app-server/process.js";
import { loadConfig } from "./config.js";
import { BridgeDatabase } from "./db.js";
import { logger } from "./logger.js";
import { ProjectResolver } from "./projects.js";
import { SessionManager } from "./sessions/manager.js";
import { ApprovalManager } from "./telegram/approvals.js";
import { TelegramApi } from "./telegram/api.js";
import { TelegramAttachmentManager } from "./telegram/attachments.js";
import { TelegramBot } from "./telegram/bot.js";
import { TelegramCommands } from "./telegram/commands.js";
import { TopicRouter } from "./telegram/router.js";
import { TopicProvisioner } from "./telegram/topics.js";
import { ParakeetVoiceTranscriber } from "./transcription/parakeet.js";

export async function runAgentger(): Promise<void> {
  const config = loadConfig();
  const db = new BridgeDatabase(config.databasePath);
  const projects = new ProjectResolver(db, config.allowedProjectRoots);
  for (const project of config.projects) db.upsertProject(project.name, await projects.validate(project.workingDirectory));
  for (const topic of config.reservedTopics) db.reserveTopic(topic.chatId, topic.threadId, topic.purpose);
  await projects.resolveDefault(config.defaultProject);

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
  const voiceTranscriber = new ParakeetVoiceTranscriber({
    ffmpegBinary: config.ffmpegBinary,
    parakeetBinary: config.parakeetBinary,
    parakeetModelPath: config.parakeetModelPath,
    parakeetDevice: config.parakeetDevice,
    timeoutMs: config.transcriptionTimeoutMs,
  });
  const attachments = new TelegramAttachmentManager(
    telegram,
    config.attachmentDirectory,
    config.telegramMaxAttachmentBytes,
    voiceTranscriber,
  );
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
  const topics = new TopicProvisioner(
    telegram,
    db,
    projects,
    router,
    client,
    sessions,
    config.defaultProject,
  );
  const bot = new TelegramBot(telegram, commands, approvals, topics, router, sessions, attachments, {
    allowedUserIds: config.allowedUserIds,
    longPollSeconds: config.telegramLongPollSeconds,
    streamUpdateIntervalMs: config.streamUpdateIntervalMs,
    completionReactionCustomEmojiId: config.telegramCompletionReactionCustomEmojiId,
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
