import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const tsc = join(projectRoot, "node_modules", "typescript", "bin", "tsc");
const nodeTypes = join(projectRoot, "node_modules", "@types", "node", "package.json");

if (!existsSync(tsc) || !existsSync(nodeTypes)) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const buildPackages = ["typescript", "@types/node"].map(
    (name) => `${name}@${packageJson.devDependencies[name]}`,
  );
  execFileSync(npm, [
    "install",
    "--ignore-scripts",
    "--no-save",
    "--package-lock=false",
    ...buildPackages,
  ], { cwd: projectRoot, stdio: "inherit" });
}

execFileSync(process.execPath, [tsc, "-p", join(projectRoot, "tsconfig.json")], {
  cwd: projectRoot,
  stdio: "inherit",
});
