import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { instanceDir, mcpHome, type PrismConfig } from "./config.js";
import { parseIni, iniGet } from "./ini.js";
import { audit, backupFiles, requireWritable } from "./safety.js";

// CurseForge (Core API) support, per PLAN.md:
// - Uses the USER'S OWN API key, read at runtime from prismlauncher.cfg
//   [General] FlameKeyOverride. The key is never returned, logged or audited.
//   Prism's built-in build key is NOT used (that key belongs to the Prism
//   project; third-party reuse is not allowed).
// - Blocked files (author disabled third-party distribution -> the API
//   returns downloadUrl: null) follow Prism's BlockedModsDialog behaviour:
//   they are reported with their mod-page download URL and recorded; the
//   user downloads them manually and resolve_blocked_mods places them by
//   sha1. NO scraping or mirror workarounds are implemented.
// - If prismlauncher.cfg FallbackMRBlockedMods is on, a blocked file is
//   first looked up on Modrinth by sha1 (Prism's own fallback) and the
//   identical file is installed from there when found.

const API = "https://api.curseforge.com/v1";
const GAME_ID = 432; // Minecraft
const MOD_CLASS_ID = 6; // Mods
const UA = "prism-mcp (https://github.com/KeiNodens/prism-mcp)";

const LOADER_TYPE: Record<string, number> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};

function sha1(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

interface GlobalCfg {
  flameKey?: string;
  fallbackMrBlocked: boolean;
}

function readGlobalCfg(cfg: PrismConfig): GlobalCfg {
  const cfgPath = path.join(cfg.dataDir, "prismlauncher.cfg");
  if (!fs.existsSync(cfgPath)) return { fallbackMrBlocked: false };
  const ini = parseIni(fs.readFileSync(cfgPath, "utf8"));
  const key = iniGet(ini, "General", "FlameKeyOverride")?.trim();
  const fb = iniGet(ini, "General", "FallbackMRBlockedMods")?.trim().toLowerCase();
  return { flameKey: key || undefined, fallbackMrBlocked: fb === "true" };
}

async function cfFetch<T>(cfg: PrismConfig, apiPath: string): Promise<T> {
  const { flameKey } = readGlobalCfg(cfg);
  if (!flameKey) {
    throw new Error(
      "No CurseForge API key: FlameKeyOverride in prismlauncher.cfg is empty. " +
        "The user must set their own key (Prism Settings > APIs, or tools/setup-cf-key.ps1). " +
        "Do not ask them to paste the key into chat.",
    );
  }
  const res = await fetch(`${API}${apiPath}`, {
    headers: { "x-api-key": flameKey, Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`CurseForge API HTTP ${res.status} for ${apiPath}`);
  const body = (await res.json()) as { data: T };
  return body.data;
}

// ---- API shapes (subset) ----

export interface CfMod {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloadCount: number;
  categories?: { name: string }[];
}

export interface CfFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  releaseType: number; // 1=release 2=beta 3=alpha
  fileDate: string;
  gameVersions: string[];
  downloadUrl: string | null;
  isAvailable: boolean;
  hashes: { algo: number; value: string }[]; // algo 1 = sha1
  dependencies: { modId: number; fileId?: number; relationType: number }[]; // 3 = required
}

// ---- pure helpers (unit-tested) ----

export function fileMatches(file: CfFile, mcVersion?: string, loaderName?: string): boolean {
  const gv = file.gameVersions.map((v) => v.toLowerCase());
  if (mcVersion && !gv.includes(mcVersion.toLowerCase())) return false;
  if (loaderName && !gv.includes(loaderName.toLowerCase())) return false;
  return true;
}

export function selectCfFile(files: CfFile[], mcVersion?: string, loaderName?: string): CfFile | undefined {
  const matching = files.filter((f) => fileMatches(f, mcVersion, loaderName));
  matching.sort((a, b) => a.releaseType - b.releaseType || b.id - a.id);
  return matching[0];
}

export function fileSha1(file: CfFile): string | undefined {
  return file.hashes.find((h) => h.algo === 1)?.value.toLowerCase();
}

export function isBlocked(file: CfFile): boolean {
  return !file.downloadUrl;
}

export function modPageDownloadUrl(slug: string, fileId: number): string {
  return `https://www.curseforge.com/minecraft/mc-mods/${slug}/download/${fileId}`;
}


// Server-side filtered file listing: the unfiltered list is newest-first and
// a popular mod's older game-version files fall off the first page, so always
// ask the API for the instance's game version (and loader) directly.
async function fetchFilesFiltered(
  cfg: PrismConfig,
  modId: number,
  mcVersion?: string,
  loader?: string,
): Promise<CfFile[]> {
  const lt = loader ? LOADER_TYPE[loader.toLowerCase()] : undefined;
  if (mcVersion && lt !== undefined) {
    const filtered = await cfFetch<CfFile[]>(
      cfg,
      `/mods/${modId}/files?gameVersion=${encodeURIComponent(mcVersion)}&modLoaderType=${lt}&pageSize=50`,
    );
    if (filtered.length > 0) return filtered;
  }
  if (mcVersion) {
    return cfFetch<CfFile[]>(cfg, `/mods/${modId}/files?gameVersion=${encodeURIComponent(mcVersion)}&pageSize=50`);
  }
  return cfFetch<CfFile[]>(cfg, `/mods/${modId}/files?pageSize=50`);
}

// ---- search ----

export async function searchModsCf(
  cfg: PrismConfig,
  args: { query: string; gameVersion?: string; loader?: string; pageSize?: number },
) {
  const params = new URLSearchParams({
    gameId: String(GAME_ID),
    classId: String(MOD_CLASS_ID),
    searchFilter: args.query,
    pageSize: String(Math.min(args.pageSize ?? 10, 50)),
    sortField: "2", // popularity
    sortOrder: "desc",
  });
  if (args.gameVersion) params.set("gameVersion", args.gameVersion);
  const lt = args.loader ? LOADER_TYPE[args.loader.toLowerCase()] : undefined;
  if (lt !== undefined) params.set("modLoaderType", String(lt));
  const data = await cfFetch<CfMod[]>(cfg, `/mods/search?${params}`);
  return data.map((m) => ({
    id: m.id,
    name: m.name,
    slug: m.slug,
    summary: m.summary,
    downloads: m.downloadCount,
    page: `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`,
  }));
}

// ---- blocked records ----

export interface BlockedRecord {
  modId: number;
  fileId: number;
  modName: string;
  fileName: string;
  sha1?: string;
  url: string;
  recordedAt: string;
}

function blockedPath(cfg: PrismConfig, instanceId: string): string {
  return path.join(mcpHome(cfg.dataDir), "blocked", `${instanceId}.json`);
}

export function loadBlocked(cfg: PrismConfig, instanceId: string): BlockedRecord[] {
  const p = blockedPath(cfg, instanceId);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    return (Array.isArray(parsed) ? parsed : [parsed]) as BlockedRecord[];
  } catch {
    return [];
  }
}

function saveBlocked(cfg: PrismConfig, instanceId: string, records: BlockedRecord[]): void {
  const p = blockedPath(cfg, instanceId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(records, null, 2), "utf8");
}

function recordBlocked(cfg: PrismConfig, instanceId: string, rec: BlockedRecord): void {
  const all = loadBlocked(cfg, instanceId);
  if (!all.some((r) => r.fileId === rec.fileId)) {
    all.push(rec);
    saveBlocked(cfg, instanceId, all);
  }
}

// ---- install ----

function writeCfIndexFile(
  indexDir: string,
  slug: string,
  fileName: string,
  file: CfFile,
  modId: number,
  downloadUrl: string,
): void {
  fs.mkdirSync(indexDir, { recursive: true });
  const toml = [
    `name = ${JSON.stringify(fileName.replace(/\.jar$/i, ""))}`,
    `filename = ${JSON.stringify(fileName)}`,
    `side = "both"`,
    ``,
    `[download]`,
    `url = ${JSON.stringify(downloadUrl)}`,
    `hash-format = "sha1"`,
    `hash = ${JSON.stringify(fileSha1(file) ?? "")}`,
    ``,
    `[update]`,
    `[update.curseforge]`,
    `file-id = ${file.id}`,
    `project-id = ${modId}`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(indexDir, `${slug}.pw.toml`), toml, "utf8");
}

async function downloadVerified(url: string, expectedSha1?: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`download failed HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expectedSha1 && sha1(buf) !== expectedSha1) {
    throw new Error(`sha1 mismatch for ${url}`);
  }
  return buf;
}

// Prism's own fallback: identical file on Modrinth, found by sha1.
async function modrinthUrlBySha1(hash: string): Promise<string | undefined> {
  const res = await fetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) return undefined;
  const version = (await res.json()) as { files: { url: string; primary: boolean; hashes: { sha1: string } }[] };
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  return file?.url;
}

export interface CfInstallOutcome {
  installed: { mod: string; file: string; via?: string }[];
  blocked: BlockedRecord[];
  skippedOptionalDeps: string[];
  unresolvedDeps: string[];
}

async function installCfFile(
  cfg: PrismConfig,
  instanceId: string,
  modsDir: string,
  mod: CfMod,
  file: CfFile,
  out: CfInstallOutcome,
  visited: Set<number>,
  depth: number,
): Promise<void> {
  const expected = fileSha1(file);
  if (isBlocked(file)) {
    // Try the Modrinth sha1 fallback first when the user enabled it in Prism.
    if (readGlobalCfg(cfg).fallbackMrBlocked && expected) {
      const mrUrl = await modrinthUrlBySha1(expected);
      if (mrUrl) {
        const buf = await downloadVerified(mrUrl, expected);
        const target = path.join(modsDir, file.fileName);
        if (fs.existsSync(target)) backupFiles(cfg, [target]);
        fs.writeFileSync(target, buf);
        writeCfIndexFile(path.join(modsDir, ".index"), mod.slug, file.fileName, file, mod.id, mrUrl);
        out.installed.push({ mod: mod.name, file: file.fileName, via: "modrinth-sha1-fallback" });
        await installDeps(cfg, instanceId, modsDir, file, out, visited, depth);
        return;
      }
    }
    const rec: BlockedRecord = {
      modId: mod.id,
      fileId: file.id,
      modName: mod.name,
      fileName: file.fileName,
      sha1: expected,
      url: modPageDownloadUrl(mod.slug, file.id),
      recordedAt: new Date().toISOString(),
    };
    recordBlocked(cfg, instanceId, rec);
    out.blocked.push(rec);
    return;
  }
  const buf = await downloadVerified(file.downloadUrl as string, expected);
  const target = path.join(modsDir, file.fileName);
  if (fs.existsSync(target)) backupFiles(cfg, [target]);
  fs.writeFileSync(target, buf);
  writeCfIndexFile(path.join(modsDir, ".index"), mod.slug, file.fileName, file, mod.id, file.downloadUrl as string);
  out.installed.push({ mod: mod.name, file: file.fileName });
  await installDeps(cfg, instanceId, modsDir, file, out, visited, depth);
}

async function installDeps(
  cfg: PrismConfig,
  instanceId: string,
  modsDir: string,
  file: CfFile,
  out: CfInstallOutcome,
  visited: Set<number>,
  depth: number,
): Promise<void> {
  if (depth >= 4) return;
  const { getInstance } = await import("./instances.js");
  const inst = getInstance(cfg, instanceId);
  for (const dep of file.dependencies) {
    if (dep.relationType !== 3) {
      if (dep.relationType === 2) out.skippedOptionalDeps.push(String(dep.modId));
      continue;
    }
    if (visited.has(dep.modId)) continue;
    visited.add(dep.modId);
    try {
      const depMod = await cfFetch<CfMod>(cfg, `/mods/${dep.modId}`);
      let depFile: CfFile;
      if (dep.fileId) {
        depFile = await cfFetch<CfFile>(cfg, `/mods/${dep.modId}/files/${dep.fileId}`);
      } else {
        const files = await fetchFilesFiltered(cfg, dep.modId, inst.mcVersion, inst.loader);
        const picked = selectCfFile(files, inst.mcVersion, inst.loader);
        if (!picked) {
          out.unresolvedDeps.push(`${depMod.name} (no file for ${inst.mcVersion}/${inst.loader ?? "any"})`);
          continue;
        }
        depFile = picked;
      }
      await installCfFile(cfg, instanceId, modsDir, depMod, depFile, out, visited, depth + 1);
    } catch (e) {
      out.unresolvedDeps.push(`mod ${dep.modId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export async function installModCf(
  cfg: PrismConfig,
  instanceId: string,
  args: { modId: number; fileId?: number },
): Promise<CfInstallOutcome & { status: string; mod: string }> {
  requireWritable(cfg);
  const instDir = instanceDir(cfg.dataDir, instanceId);
  if (!fs.existsSync(instDir)) throw new Error(`instance not found: ${instanceId}`);
  const { getInstance } = await import("./instances.js");
  const inst = getInstance(cfg, instanceId);
  const mod = await cfFetch<CfMod>(cfg, `/mods/${args.modId}`);
  let file: CfFile;
  if (args.fileId) {
    file = await cfFetch<CfFile>(cfg, `/mods/${args.modId}/files/${args.fileId}`);
  } else {
    const files = await fetchFilesFiltered(cfg, args.modId, inst.mcVersion, inst.loader);
    const picked = selectCfFile(files, inst.mcVersion, inst.loader);
    if (!picked) {
      throw new Error(
        `no CurseForge file of ${mod.name} matches ${inst.mcVersion} / ${inst.loader ?? "any loader"} (checked ${files.length} files)`,
      );
    }
    file = picked;
  }
  const modsDir = path.join(instDir, "minecraft", "mods");
  fs.mkdirSync(modsDir, { recursive: true });
  const out: CfInstallOutcome = { installed: [], blocked: [], skippedOptionalDeps: [], unresolvedDeps: [] };
  await installCfFile(cfg, instanceId, modsDir, mod, file, out, new Set([mod.id]), 0);
  const status =
    out.blocked.length === 0 ? "installed" : out.installed.length === 0 ? "blocked" : "partial_blocked";
  audit(cfg, "install_mod_cf", instanceId, {
    modId: args.modId,
    fileId: file.id,
    status,
    installed: out.installed.map((i) => i.file),
    blocked: out.blocked.map((b) => b.fileName),
  });
  return { mod: mod.name, status, ...out };
}

// ---- resolve user-downloaded blocked mods ----

export async function resolveBlockedMods(
  cfg: PrismConfig,
  instanceId: string,
  folder: string,
) {
  requireWritable(cfg);
  const records = loadBlocked(cfg, instanceId);
  if (records.length === 0) return { resolved: [], remaining: [], note: "no pending blocked mods" };
  const bySha = new Map(records.filter((r) => r.sha1).map((r) => [r.sha1 as string, r]));
  const modsDir = path.join(instanceDir(cfg.dataDir, instanceId), "minecraft", "mods");
  fs.mkdirSync(modsDir, { recursive: true });

  const candidates: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.toLowerCase().endsWith(".jar")) candidates.push(p);
    }
  };
  walk(folder);

  const resolved: { fileName: string; from: string }[] = [];
  const done = new Set<number>();
  for (const cand of candidates) {
    const digest = sha1(fs.readFileSync(cand));
    const rec = bySha.get(digest);
    if (!rec || done.has(rec.fileId)) continue;
    const target = path.join(modsDir, rec.fileName);
    if (fs.existsSync(target)) backupFiles(cfg, [target]);
    fs.copyFileSync(cand, target);
    // Minimal index entry so list_mods/update bookkeeping sees the file.
    const indexDir = path.join(modsDir, ".index");
    fs.mkdirSync(indexDir, { recursive: true });
    const slug = rec.modName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    fs.writeFileSync(
      path.join(indexDir, `${slug}.pw.toml`),
      [
        `name = ${JSON.stringify(rec.fileName.replace(/\.jar$/i, ""))}`,
        `filename = ${JSON.stringify(rec.fileName)}`,
        `side = "both"`,
        ``,
        `[download]`,
        `url = ${JSON.stringify(rec.url)}`,
        `hash-format = "sha1"`,
        `hash = ${JSON.stringify(rec.sha1)}`,
        ``,
        `[update]`,
        `[update.curseforge]`,
        `file-id = ${rec.fileId}`,
        `project-id = ${rec.modId}`,
        ``,
      ].join("\n"),
      "utf8",
    );
    done.add(rec.fileId);
    resolved.push({ fileName: rec.fileName, from: cand });
  }
  const remaining = records.filter((r) => !done.has(r.fileId));
  saveBlocked(cfg, instanceId, remaining);
  audit(cfg, "resolve_blocked_mods", instanceId, { folder, resolved: resolved.map((r) => r.fileName) });
  return { resolved, remaining };
}
