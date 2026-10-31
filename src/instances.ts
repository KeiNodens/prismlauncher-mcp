import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { instanceDir, instancesDir, mcpHome, type PrismConfig } from "./config.js";
import { parseIni, stringifyIni, iniGet, iniSet } from "./ini.js";
import { fetchIndex, resolveLwjgl, resolveLoaderVersion, LOADER_UIDS } from "./meta.js";
import { audit, backupFiles, requireConfirm, requireWritable } from "./safety.js";

export interface PackComponent {
  uid: string;
  version?: string;
  cachedName?: string;
  dependencyOnly?: boolean;
  important?: boolean;
}

export interface InstanceSummary {
  id: string;
  name: string;
  iconKey?: string;
  mcVersion?: string;
  loader?: string;
  loaderVersion?: string;
  lastLaunch?: string;
}

function readPack(dir: string): { formatVersion: number; components: PackComponent[] } | undefined {
  const p = path.join(dir, "mmc-pack.json");
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

function summarize(id: string, dir: string): InstanceSummary {
  const cfgPath = path.join(dir, "instance.cfg");
  let name = id;
  let iconKey: string | undefined;
  let lastLaunch: string | undefined;
  if (fs.existsSync(cfgPath)) {
    const ini = parseIni(fs.readFileSync(cfgPath, "utf8"));
    name = iniGet(ini, "General", "name") ?? id;
    iconKey = iniGet(ini, "General", "iconKey");
    const ts = iniGet(ini, "General", "lastLaunchTime");
    if (ts) lastLaunch = new Date(Number(ts)).toISOString();
  }
  const pack = readPack(dir);
  const mc = pack?.components.find((c) => c.uid === "net.minecraft");
  const loaderEntry = Object.entries(LOADER_UIDS)
    .map(([alias, uid]) => ({ alias, comp: pack?.components.find((c) => c.uid === uid) }))
    .find((e) => e.comp);
  return {
    id,
    name,
    iconKey,
    mcVersion: mc?.version,
    loader: loaderEntry?.alias,
    loaderVersion: loaderEntry?.comp?.version,
    lastLaunch,
  };
}

export function listInstances(cfg: PrismConfig): InstanceSummary[] {
  const root = instancesDir(cfg.dataDir);
  if (!fs.existsSync(root)) return [];
  // Follow symlinks/junctions: instances may live on external or network
  // storage and be linked into this folder (Dirent.isDirectory() is false
  // for links, so stat the target instead).
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => {
      try {
        return fs.statSync(path.join(root, e.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((e) => summarize(e.name, path.join(root, e.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getInstance(cfg: PrismConfig, id: string) {
  const dir = instanceDir(cfg.dataDir, id);
  if (!fs.existsSync(dir)) throw new Error(`instance not found: ${id}`);
  const cfgPath = path.join(dir, "instance.cfg");
  const settings: Record<string, string> = {};
  if (fs.existsSync(cfgPath)) {
    const ini = parseIni(fs.readFileSync(cfgPath, "utf8"));
    for (const [k, v] of ini.get("General") ?? []) settings[k] = v;
  }
  return {
    ...summarize(id, dir),
    dir,
    settings,
    pack: readPack(dir),
  };
}

export interface CreateInstanceArgs {
  name: string;
  mcVersion: string;
  loader?: string; // alias (forge/fabric/neoforge/quilt/liteloader) or full meta uid
  loaderVersion?: string;
  iconKey?: string;
  group?: string;
}

export async function createInstance(cfg: PrismConfig, args: CreateInstanceArgs) {
  requireWritable(cfg);
  const id = args.name.replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!id) throw new Error("instance name is empty after sanitizing");
  const dir = instanceDir(cfg.dataDir, id);
  if (fs.existsSync(dir)) throw new Error(`instance already exists: ${id}`);

  const mcIndex = await fetchIndex("net.minecraft");
  const mc = mcIndex.versions.find((v) => v.version === args.mcVersion);
  if (!mc) throw new Error(`Minecraft version not found in meta: ${args.mcVersion}`);

  const components: PackComponent[] = [];
  const lwjgl = resolveLwjgl(mc);
  if (lwjgl) {
    components.push({ uid: "org.lwjgl3", version: lwjgl, cachedName: "LWJGL 3", dependencyOnly: true });
  }
  components.push({ uid: "net.minecraft", version: args.mcVersion, cachedName: "Minecraft", important: true });

  let loaderName: string | undefined;
  if (args.loader) {
    const uid = LOADER_UIDS[args.loader] ?? args.loader;
    const idx = await fetchIndex(uid);
    const lv = resolveLoaderVersion(idx.versions, args.mcVersion, args.loaderVersion);
    loaderName = idx.name;
    components.push({ uid, version: lv.version, cachedName: idx.name, important: true });
  }

  fs.mkdirSync(dir, { recursive: true });
  const pack = { formatVersion: 1, components };
  fs.writeFileSync(path.join(dir, "mmc-pack.json"), JSON.stringify(pack, null, 4) + "\n", "utf8");

  const ini = new Map<string, Map<string, string>>();
  const general = new Map<string, string>();
  general.set("InstanceType", "OneSix");
  general.set("name", args.name);
  general.set("iconKey", args.iconKey ?? "default");
  ini.set("General", general);
  fs.writeFileSync(path.join(dir, "instance.cfg"), stringifyIni(ini), "utf8");

  if (args.group) setInstanceGroup(cfg, id, args.group);

  audit(cfg, "create_instance", id, args);
  return { id, dir, mcVersion: args.mcVersion, loader: loaderName, components };
}

export function listGroups(cfg: PrismConfig): string[] {
  // Prism stores instgroups.json inside instances/ (older layouts: data root).
  const inInstances = path.join(instancesDir(cfg.dataDir), "instgroups.json");
  const p = fs.existsSync(inInstances) ? inInstances : path.join(cfg.dataDir, "instgroups.json");
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return Object.keys(data.groups ?? {});
  } catch {
    return [];
  }
}

export function setInstanceGroup(cfg: PrismConfig, id: string, group: string): void {
  const inInstances = path.join(instancesDir(cfg.dataDir), "instgroups.json");
  const p = fs.existsSync(inInstances) ? inInstances : inInstances;
  let data: { formatVersion: number; groups: Record<string, { hidden?: boolean; instances?: string[] }> } =
    { formatVersion: 1, groups: {} };
  if (fs.existsSync(p)) {
    backupFiles(cfg, [p]);
    data = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  data.groups ??= {};
  for (const g of Object.values(data.groups)) {
    g.instances = (g.instances ?? []).filter((x) => x !== id);
  }
  data.groups[group] ??= { hidden: false, instances: [] };
  data.groups[group].instances!.push(id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 4) + "\n", "utf8");
}

export function deleteInstance(cfg: PrismConfig, id: string, confirm?: boolean) {
  requireWritable(cfg);
  requireConfirm("delete_instance", confirm);
  const dir = instanceDir(cfg.dataDir, id);
  if (!fs.existsSync(dir)) throw new Error(`instance not found: ${id}`);
  backupFiles(cfg, [path.join(dir, "instance.cfg"), path.join(dir, "mmc-pack.json")]);
  fs.rmSync(dir, { recursive: true, force: true });
  audit(cfg, "delete_instance", id, {});
  return { deleted: id };
}

export function cloneInstance(cfg: PrismConfig, id: string, newName: string) {
  requireWritable(cfg);
  const src = instanceDir(cfg.dataDir, id);
  if (!fs.existsSync(src)) throw new Error(`instance not found: ${id}`);
  const newId = newName.replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!newId) throw new Error("new name is empty after sanitizing");
  const dest = instanceDir(cfg.dataDir, newId);
  if (fs.existsSync(dest)) throw new Error(`instance already exists: ${newId}`);
  fs.cpSync(src, dest, { recursive: true });
  // Point the copy at its new name.
  const cfgPath = path.join(dest, "instance.cfg");
  if (fs.existsSync(cfgPath)) {
    const ini = parseIni(fs.readFileSync(cfgPath, "utf8"));
    iniSet(ini, "General", "name", newName);
    iniSet(ini, "General", "lastLaunchTime", "0");
    fs.writeFileSync(cfgPath, stringifyIni(ini), "utf8");
  }
  audit(cfg, "clone_instance", newId, { from: id });
  return { id: newId, dir: dest, clonedFrom: id };
}

export function setInstanceSetting(cfg: PrismConfig, id: string, key: string, value: string) {
  requireWritable(cfg);
  const cfgPath = path.join(instanceDir(cfg.dataDir, id), "instance.cfg");
  if (!fs.existsSync(cfgPath)) throw new Error(`instance not found: ${id}`);
  backupFiles(cfg, [cfgPath]);
  const ini = parseIni(fs.readFileSync(cfgPath, "utf8"));
  iniSet(ini, "General", key, value);
  fs.writeFileSync(cfgPath, stringifyIni(ini), "utf8");
  audit(cfg, "set_instance_setting", id, { key, value });
  return { id, key, value };
}

export function getInstanceSetting(cfg: PrismConfig, id: string, key: string) {
  const cfgPath = path.join(instanceDir(cfg.dataDir, id), "instance.cfg");
  if (!fs.existsSync(cfgPath)) throw new Error(`instance not found: ${id}`);
  const ini = parseIni(fs.readFileSync(cfgPath, "utf8"));
  return { id, key, value: iniGet(ini, "General", key) ?? null };
}

// File-level plain-zip export (the no-bridge fallback of export_instance).
// Mirrors the bridge's exclusions: logs, crash reports, backups and lock
// files never belong in an exported instance archive.
export function exportInstanceZip(cfg: PrismConfig, id: string, output?: string) {
  requireWritable(cfg);
  const root = instanceDir(cfg.dataDir, id);
  if (!fs.existsSync(root)) throw new Error(`instance not found: ${id}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = output ?? path.join(mcpHome(cfg.dataDir), "exports", `${id}-${stamp}.zip`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const skip = (rel: string) => {
    const segments = rel.replace(/\\/g, "/").split("/");
    if (segments.includes("logs") || segments.includes("crash-reports") || segments.includes("backups")) return true;
    const name = segments[segments.length - 1];
    return name.endsWith(".log") || name === "session.lock" || name.endsWith(".lck");
  };
  const zip = new AdmZip();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (skip(rel)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const parent = path.dirname(rel);
        zip.addLocalFile(full, parent === "." ? "" : parent.replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  zip.writeZip(dest);
  audit(cfg, "export_instance", id, { format: "zip", output: dest });
  return { id, format: "zip", output: dest, viaBridge: false };
}
