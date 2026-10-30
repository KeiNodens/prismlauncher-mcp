import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PrismConfig {
  dataDir: string;
  readOnly: boolean;
  prismExe?: string;
}

// Data dir resolution order (per PLAN.md §7):
//   --data-dir arg / PRISM_DATA_DIR env -> exe-adjacent UserData/ -> %APPDATA%\PrismLauncher
export function loadConfig(argv: string[]): PrismConfig {
  let dataDir: string | undefined;
  let readOnly = process.env.PRISM_MCP_READ_ONLY === "1";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir" && argv[i + 1]) dataDir = argv[++i];
    if (argv[i] === "--read-only") readOnly = true;
  }
  if (!dataDir) dataDir = process.env.PRISM_DATA_DIR;
  if (!dataDir) {
    const adjacent = path.join(path.dirname(process.execPath), "UserData");
    if (fs.existsSync(path.join(adjacent, "prismlauncher.cfg"))) dataDir = adjacent;
  }
  if (!dataDir) {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    dataDir = path.join(appData, "PrismLauncher");
  }
  return {
    dataDir,
    readOnly,
    prismExe: process.env.PRISM_EXE,
  };
}

export function mcpHome(dataDir: string): string {
  return path.join(dataDir, "prism-mcp");
}

export function instancesDir(dataDir: string): string {
  return path.join(dataDir, "instances");
}

export function instanceDir(dataDir: string, id: string): string {
  // Instance id is a directory name; refuse path traversal outright.
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid instance id: ${id}`);
  }
  return path.join(instancesDir(dataDir), id);
}
