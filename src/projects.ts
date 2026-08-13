import { realpath } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { BridgeDatabase } from "./db.js";

export class ProjectNotFoundError extends Error {}
export class ProjectPathDeniedError extends Error {}

function within(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export class ProjectResolver {
  private readonly deniedRoots = ["/", "/etc", resolve(homedir(), ".ssh")]
    .map((path) => existsSync(path) ? realpathSync(path) : path);
  private readonly allowedRoots: string[];

  constructor(
    private readonly db: BridgeDatabase,
    allowedRoots: string[],
  ) {
    if (allowedRoots.length === 0) throw new Error("At least one allowed project root is required");
    if (allowedRoots.some((root) => !isAbsolute(root) || root === "/")) {
      throw new Error("Allowed project roots must be absolute and may not include /");
    }
    this.allowedRoots = allowedRoots.map((root) => realpathSync(root));
    if (this.allowedRoots.some((root) => this.deniedRoots.some((denied) =>
      denied === "/" ? root === denied : within(root, denied)
    ))) {
      throw new Error("Allowed project roots must not include protected directories");
    }
  }

  async resolveAlias(name: string): Promise<string> {
    const project = this.db.getProject(name);
    if (!project) throw new ProjectNotFoundError(`Unknown project alias: ${name}`);
    return this.validate(project.workingDirectory);
  }

  async resolveDefault(name: string | null): Promise<string> {
    if (name) return this.resolveAlias(name);
    const projects = this.db.listProjects();
    if (projects.length !== 1) {
      throw new ProjectNotFoundError(
        "Set DEFAULT_PROJECT, or configure exactly one PROJECTS alias for automatic topics",
      );
    }
    return this.validate(projects[0]!.workingDirectory);
  }

  async validate(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new ProjectPathDeniedError("Project path must be absolute");
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (error) {
      throw new ProjectPathDeniedError(`Project path cannot be resolved: ${String(error)}`);
    }
    if (this.deniedRoots.some((root) => root === "/" ? canonical === root : within(canonical, root))) {
      throw new ProjectPathDeniedError(`Project path is protected: ${canonical}`);
    }
    if (!this.allowedRoots.some((root) => within(canonical, root))) {
      throw new ProjectPathDeniedError(`Project path is outside ALLOWED_PROJECT_ROOTS: ${canonical}`);
    }
    return canonical;
  }
}
