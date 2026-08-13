#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";

const VERSION = "0.2.0";

function usage(): string {
  return `Agentger ${VERSION}

Telegram topic UI for Codex agents.

Usage:
  agentger [start]       Start the Telegram bridge and codex app-server
  agentger init          Create .env from the packaged example
  agentger doctor        Validate configuration and Codex availability
  agentger --version     Print the version
  agentger --help        Show this help`;
}

function packageFile(name: string): string {
  const candidates = [
    new URL(`../${name}`, import.meta.url),
    new URL(`../../${name}`, import.meta.url),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) throw new Error(`Packaged file not found: ${name}`);
  return fileURLToPath(match);
}

function initializeConfig(): void {
  const destination = resolve(process.cwd(), ".env");
  if (existsSync(destination)) throw new Error(`${destination} already exists`);
  copyFileSync(packageFile(".env.example"), destination, constants.COPYFILE_EXCL);
  process.stdout.write(`Created ${destination}\nEdit it, then run: agentger doctor\n`);
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  const version = execFileSync(config.codexBinary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const [{ BridgeDatabase }, { ProjectResolver }] = await Promise.all([
    import("./db.js"),
    import("./projects.js"),
  ]);
  const db = new BridgeDatabase(config.databasePath);
  let defaultCwd: string;
  try {
    const projects = new ProjectResolver(db, config.allowedProjectRoots);
    for (const project of config.projects) db.upsertProject(project.name, await projects.validate(project.workingDirectory));
    defaultCwd = await projects.resolveDefault(config.defaultProject);
  } finally {
    db.close();
  }
  process.stdout.write([
    "Agentger configuration is valid.",
    `Codex: ${version}`,
    `Database: ${config.databasePath}`,
    `Allowed roots: ${config.allowedProjectRoots.join(", ")}`,
    `Projects: ${config.projects.map((project) => project.name).join(", ") || "database only"}`,
    `Default project: ${config.defaultProject ?? "the only configured alias"} → ${defaultCwd}`,
    `Reserved topics: ${config.reservedTopics.length}`,
  ].join("\n") + "\n");
}

async function main(): Promise<void> {
  const [command = "start", ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new Error(`Unexpected arguments: ${extra.join(" ")}`);
  switch (command) {
    case "start":
      await (await import("./main.js")).runAgentger();
      return;
    case "init":
      initializeConfig();
      return;
    case "doctor":
      await doctor();
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(`${usage()}\n`);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  logger.error("Agentger failed", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exitCode = 1;
});
