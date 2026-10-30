import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { instanceDir, type PrismConfig } from "./config.js";
import { audit, requireConfirm, requireWritable } from "./safety.js";

const execFileP = promisify(execFile);

function resolveExe(cfg: PrismConfig): string {
  if (cfg.prismExe) return cfg.prismExe;
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const candidate = path.join(local, "Programs", "PrismLauncher", "prismlauncher.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "prismlauncher.exe"; // rely on PATH
}

function logPath(cfg: PrismConfig, id: string): string {
  return path.join(instanceDir(cfg.dataDir, id), "minecraft", "logs", "latest.log");
}

async function matchingJavaPids(instDirPath: string): Promise<number[]> {
  // Match javaw/java processes whose command line references this instance dir.
  const ps = [
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='javaw.exe' OR Name='java.exe'\"",
    "| Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:PRISM_MCP_MATCH) }",
    "| Select-Object -ExpandProperty ProcessId",
  ].join(" ");
  try {
    const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-Command", ps], {
      env: { ...process.env, PRISM_MCP_MATCH: instDirPath },
    });
    return stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

export function launchInstance(
  cfg: PrismConfig,
  id: string,
  opts: { world?: string; server?: string; profile?: string; offline?: string } = {},
) {
  requireWritable(cfg);
  const dir = instanceDir(cfg.dataDir, id);
  if (!fs.existsSync(dir)) throw new Error(`instance not found: ${id}`);
  const exe = resolveExe(cfg);
  const args = ["--dir", cfg.dataDir, "--launch", id];
  if (opts.server) args.push("--server", opts.server);
  if (opts.world) args.push("--world", opts.world);
  if (opts.profile) args.push("--profile", opts.profile);
  if (opts.offline) args.push("--offline", opts.offline);
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();
  audit(cfg, "launch_instance", id, opts);
  return { launched: id, exe, args, note: "Prism starts the game asynchronously; poll get_instance_status / wait_for_event" };
}

export async function getInstanceStatus(cfg: PrismConfig, id: string) {
  const dir = instanceDir(cfg.dataDir, id);
  const pids = await matchingJavaPids(dir);
  const lp = logPath(cfg, id);
  const logExists = fs.existsSync(lp);
  const logMtime = logExists ? fs.statSync(lp).mtime.toISOString() : undefined;
  let lastLines: string[] = [];
  if (logExists) {
    const text = fs.readFileSync(lp, "utf8");
    lastLines = text.split(/\r?\n/).filter(Boolean).slice(-5);
  }
  return {
    id,
    running: pids.length > 0,
    pids,
    logExists,
    logMtime,
    lastLogLines: lastLines,
  };
}

export function tailLog(cfg: PrismConfig, id: string, lines = 100): string {
  const lp = logPath(cfg, id);
  if (!fs.existsSync(lp)) return "";
  const text = fs.readFileSync(lp, "utf8");
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

export async function waitForEvent(
  cfg: PrismConfig,
  id: string,
  pattern: string,
  timeoutMs = 120_000,
): Promise<{ matched: boolean; line?: string; waitedMs: number }> {
  const lp = logPath(cfg, id);
  const started = Date.now();
  const re = new RegExp(pattern, "i");
  let offset = fs.existsSync(lp) ? fs.statSync(lp).size : 0;
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(lp)) {
      const size = fs.statSync(lp).size;
      if (size > offset) {
        const fd = fs.openSync(lp, "r");
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = size;
        for (const line of buf.toString("utf8").split(/\r?\n/)) {
          if (re.test(line)) return { matched: true, line, waitedMs: Date.now() - started };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { matched: false, waitedMs: Date.now() - started };
}

export async function stopInstance(cfg: PrismConfig, id: string, confirm?: boolean) {
  requireWritable(cfg);
  requireConfirm("stop_instance", confirm);
  const dir = instanceDir(cfg.dataDir, id);
  const pids = await matchingJavaPids(dir);
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      await execFileP("taskkill.exe", ["/PID", String(pid)]).catch(() => undefined);
    }
  }
  audit(cfg, "stop_instance", id, { pids });
  return { stopped: id, pids };
}

export function listScreenshots(cfg: PrismConfig, id: string) {
  const dir = path.join(instanceDir(cfg.dataDir, id), "minecraft", "screenshots");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, size: st.size, mtime: st.mtime.toISOString() };
    });
}

export function getScreenshot(cfg: PrismConfig, id: string, file: string) {
  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    throw new Error("invalid screenshot name");
  }
  const p = path.join(instanceDir(cfg.dataDir, id), "minecraft", "screenshots", file);
  if (!fs.existsSync(p)) throw new Error(`screenshot not found: ${file}`);
  return { base64: fs.readFileSync(p).toString("base64"), mimeType: "image/png" };
}
