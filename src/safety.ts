import fs from "node:fs";
import path from "node:path";
import { mcpHome, type PrismConfig } from "./config.js";

// Safety plumbing (PLAN.md §3.3):
// - every mutation is appended to prism-mcp/agent-ops.jsonl
// - destructive tools require confirm: true
// - files about to be overwritten/deleted are copied to prism-mcp/backups/<ts>/

export function audit(cfg: PrismConfig, tool: string, target: string, args: unknown): void {
  const home = mcpHome(cfg.dataDir);
  fs.mkdirSync(home, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), tool, target, args });
  fs.appendFileSync(path.join(home, "agent-ops.jsonl"), line + "\n", "utf8");
}

export function requireWritable(cfg: PrismConfig): void {
  if (cfg.readOnly) throw new Error("server is running with --read-only; mutation tools are disabled");
}

export function requireConfirm(tool: string, confirm?: boolean): void {
  if (confirm !== true) {
    throw new Error(`${tool} is destructive; call again with confirm: true to proceed`);
  }
}

export function backupFiles(cfg: PrismConfig, files: string[]): string | undefined {
  const existing = files.filter((f) => fs.existsSync(f));
  if (existing.length === 0) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destDir = path.join(mcpHome(cfg.dataDir), "backups", stamp);
  for (const f of existing) {
    const dest = path.join(destDir, path.relative(cfg.dataDir, f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
  }
  return destDir;
}
