import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import nbt from "prismarine-nbt";
import { instanceDir, type PrismConfig } from "./config.js";
import { audit, backupFiles, requireWritable } from "./safety.js";

// Read-only world inspection (level.dat) plus options.txt get/set.
// Writes to level.dat itself are intentionally out of scope for v1
// (gamerules live in the NBT; a wrong write corrupts the world).

function savesDir(cfg: PrismConfig, instanceId: string): string {
  return path.join(instanceDir(cfg.dataDir, instanceId), "minecraft", "saves");
}

interface LevelData {
  name?: string;
  version?: string;
  gameType?: number;
  difficulty?: number;
  dataVersion?: number;
  seed?: string;
  lastPlayed?: string;
  generatorName?: string;
}

async function readLevel(worldDir: string): Promise<LevelData> {
  const p = path.join(worldDir, "level.dat");
  const raw = fs.readFileSync(p);
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
  const { parsed } = await nbt.parse(buf);
  // NBT trees are loosely typed; treat the Data compound as a plain record.
  const data: any = (parsed as any).value.Data.value;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    name: str(data.LevelName?.value),
    version: str(data.Version?.value?.Name?.value),
    gameType: num(data.GameType?.value),
    difficulty: num(data.Difficulty?.value),
    dataVersion: num(data.DataVersion?.value),
    seed: data.WorldGenSettings?.value?.seed?.value?.toString() ?? data.RandomSeed?.value?.toString(),
    lastPlayed: data.LastPlayed?.value
      ? new Date(Number(data.LastPlayed.value)).toISOString()
      : undefined,
    generatorName: str(data.generatorName?.value),
  };
}

export async function listWorlds(cfg: PrismConfig, instanceId: string) {
  const dir = savesDir(cfg, instanceId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const wd = path.join(dir, e.name);
    if (!fs.existsSync(path.join(wd, "level.dat"))) continue;
    try {
      out.push({ folder: e.name, ...(await readLevel(wd)) });
    } catch {
      out.push({ folder: e.name, error: "level.dat could not be parsed" });
    }
  }
  return out;
}

export async function getWorld(cfg: PrismConfig, instanceId: string, world: string) {
  if (world.includes("/") || world.includes("\\") || world.includes("..")) {
    throw new Error("invalid world name");
  }
  const wd = path.join(savesDir(cfg, instanceId), world);
  if (!fs.existsSync(path.join(wd, "level.dat"))) throw new Error(`world not found: ${world}`);
  return { folder: world, dir: wd, ...(await readLevel(wd)) };
}

// ---- options.txt (key:value lines) ----

function optionsPath(cfg: PrismConfig, instanceId: string): string {
  return path.join(instanceDir(cfg.dataDir, instanceId), "minecraft", "options.txt");
}

export function getOptions(cfg: PrismConfig, instanceId: string): Record<string, string> {
  const p = optionsPath(cfg, instanceId);
  if (!fs.existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export function setOption(cfg: PrismConfig, instanceId: string, key: string, value: string) {
  requireWritable(cfg);
  const p = optionsPath(cfg, instanceId);
  const lines = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split(/\r?\n/) : [];
  backupFiles(cfg, [p]);
  let found = false;
  const next = lines.map((line) => {
    const i = line.indexOf(":");
    if (i > 0 && line.slice(0, i) === key) {
      found = true;
      return `${key}:${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}:${value}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, next.join("\n"), "utf8");
  audit(cfg, "set_option", instanceId, { key, value });
  return { key, value };
}
