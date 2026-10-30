import fs from "node:fs";
import path from "node:path";
import type { PrismConfig } from "./config.js";
import { parseIni, stringifyIni, iniGet, iniSet } from "./ini.js";
import { audit, backupFiles, requireWritable } from "./safety.js";

function globalCfgPath(cfg: PrismConfig): string {
  return path.join(cfg.dataDir, "prismlauncher.cfg");
}

export function getSettings(cfg: PrismConfig, section = "General") {
  const p = globalCfgPath(cfg);
  if (!fs.existsSync(p)) return {};
  const ini = parseIni(fs.readFileSync(p, "utf8"));
  const out: Record<string, string> = {};
  for (const [k, v] of ini.get(section) ?? []) out[k] = v;
  return out;
}

export function getSetting(cfg: PrismConfig, key: string, section = "General") {
  const p = globalCfgPath(cfg);
  if (!fs.existsSync(p)) return undefined;
  const ini = parseIni(fs.readFileSync(p, "utf8"));
  return iniGet(ini, section, key);
}

export async function setSetting(cfg: PrismConfig, key: string, value: string, section = "General") {
  requireWritable(cfg);
  const p = globalCfgPath(cfg);
  if (!fs.existsSync(p)) throw new Error("prismlauncher.cfg not found (has Prism run in this data dir yet?)");
  backupFiles(cfg, [p]);
  const ini = parseIni(fs.readFileSync(p, "utf8"));
  iniSet(ini, section, key, value);
  fs.writeFileSync(p, stringifyIni(ini), "utf8");
  audit(cfg, "set_setting", "global", { key, value, section });
  // Many global keys are read at Prism startup only.
  const { execFile } = await import("node:child_process");
  const running = await new Promise<boolean>((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", "if (Get-Process prismlauncher -ErrorAction SilentlyContinue) { 'yes' }"], (err, stdout) =>
      resolve(!err && stdout.includes("yes")),
    );
  });
  return { key, value, section, requiresPrismRestart: running };
}
