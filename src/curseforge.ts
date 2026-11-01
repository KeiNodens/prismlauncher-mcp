import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import { instanceDir, mcpHome, type PrismConfig } from "./config.js";
import { parseIni, iniGet } from "./ini.js";
import { audit, backupFiles, requireWritable } from "./safety.js";
import { readInstalledIds } from "./modrinth.js";

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
const UA = "prismlauncher-mcp (https://github.com/KeiNodens/prismlauncher-mcp)";

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

async function cfPost<T>(cfg: PrismConfig, apiPath: string, bodyObj: unknown): Promise<T> {
  const { flameKey } = readGlobalCfg(cfg);
  if (!flameKey) {
    throw new Error(
      "No CurseForge API key: FlameKeyOverride in prismlauncher.cfg is empty. " +
        "The user must set their own key (Prism Settings > APIs, or tools/setup-cf-key.ps1). " +
        "Do not ask them to paste the key into chat.",
    );
  }
  const res = await fetch(`${API}${apiPath}`, {
    method: "POST",
    headers: { "x-api-key": flameKey, Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(bodyObj),
  });
  if (!res.ok) throw new Error(`CurseForge API HTTP ${res.status} for ${apiPath}`);
  const body = (await res.json()) as { data: T };
  return body.data;
}

// CurseForge's file fingerprint: MurmurHash2 (m=0x5bd1e995, r=24, seed 1)
// over the file bytes with whitespace bytes (tab, LF, CR, space) removed.
// The same algorithm Prism itself uses (libraries/murmur2); it identifies
// jars that carry no packwiz index entry, e.g. mods bundled in modpacks.
// The auto-pick prefers the newest RELEASE, so for a mod currently on a
// newer beta/alpha file the pick can be OLDER than what is installed.
// Proposing that as an "update" would silently downgrade the mod; treat a
// pick that is not newer by file date as up to date instead.
export function isCfPickDowngrade(files: CfFile[], currentFileId: number, picked: CfFile): boolean {
  if (picked.id === currentFileId) return false;
  const current = files.find((f) => f.id === currentFileId);
  if (!current) return false;
  return picked.fileDate <= current.fileDate;
}

export function cfFingerprint(buf: Buffer): number {  const M = 0x5bd1e995;
  const bytes: number[] = [];
  for (const b of buf) if (b !== 9 && b !== 10 && b !== 13 && b !== 32) bytes.push(b);
  const len = bytes.length;
  let h = (1 ^ len) >>> 0;
  let i = 0;
  let remaining = len;
  while (remaining >= 4) {
    let k = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
    k = Math.imul(k, M) >>> 0;
    k = (k ^ (k >>> 24)) >>> 0;
    k = Math.imul(k, M) >>> 0;
    h = Math.imul(h, M) >>> 0;
    h = (h ^ k) >>> 0;
    i += 4;
    remaining -= 4;
  }
  if (remaining === 3) h = (h ^ (bytes[i + 2] << 16)) >>> 0;
  if (remaining >= 2) h = (h ^ (bytes[i + 1] << 8)) >>> 0;
  if (remaining >= 1) {
    h = (h ^ bytes[i]) >>> 0;
    h = Math.imul(h, M) >>> 0;
  }
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, M) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

export interface CfFingerprintHit {
  file: string;
  modId: number;
  fileId: number;
}

// Identify jar files (names within modsDir) as CurseForge files by
// fingerprint. Unmatched files simply do not appear in the result.
export async function lookupCfFingerprints(
  cfg: PrismConfig,
  modsDir: string,
  fileNames: string[],
): Promise<CfFingerprintHit[]> {
  if (fileNames.length === 0) return [];
  const fingerprints = fileNames.map((f) => cfFingerprint(fs.readFileSync(path.join(modsDir, f))));
  const data = await cfPost<{ exactMatches?: { file: { id: number; modId: number; fileName: string } }[] }>(
    cfg,
    "/fingerprints",
    { fingerprints },
  );
  const wanted = new Set(fileNames);
  return (data.exactMatches ?? [])
    .map((m) => ({ file: m.file.fileName, modId: m.file.modId, fileId: m.file.id }))
    .filter((hit) => wanted.has(hit.file));
}

export async function getCfModsByIds(cfg: PrismConfig, ids: number[]): Promise<CfMod[]> {
  if (ids.length === 0) return [];
  return cfPost<CfMod[]>(cfg, "/mods", { modIds: ids, filterPcOnly: true });
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


export function cfReleaseLabel(releaseType: number): string {
  return releaseType === 1 ? "release" : releaseType === 2 ? "beta" : releaseType === 3 ? "alpha" : String(releaseType);
}

export async function listModFilesCf(cfg: PrismConfig, args: { modId: number; instanceId?: string }) {
  const mod = await cfFetch<CfMod>(cfg, `/mods/${args.modId}`);
  let mcVersion: string | undefined;
  let loader: string | undefined;
  if (args.instanceId) {
    const { getInstance } = await import("./instances.js");
    const inst = getInstance(cfg, args.instanceId);
    mcVersion = inst.mcVersion;
    loader = inst.loader;
  }
  const files = await fetchFilesFiltered(cfg, args.modId, mcVersion, loader);
  const listings = files.map((f) => ({
    fileId: f.id,
    displayName: f.displayName,
    fileName: f.fileName,
    type: cfReleaseLabel(f.releaseType),
    fileDate: f.fileDate,
    gameVersions: f.gameVersions,
    blocked: isBlocked(f),
    matchesInstance: fileMatches(f, mcVersion, loader),
  }));
  const picked = selectCfFile(files, mcVersion, loader);
  return {
    mod: mod.name,
    autoPick: picked
      ? { fileId: picked.id, fileName: picked.fileName, type: cfReleaseLabel(picked.releaseType) }
      : undefined,
    files: listings.slice(0, 50),
    note: "Install a specific file with install_mod_cf's fileId (for rollback when a release is buggy).",
  };
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
  declaredIncompatibles: { modId: number; name: string }[];
  incompatibleWarnings: { modId: number; name: string }[];
  dependencyConflicts: { modId: number; keptFileId: number; requestedFileId: number }[];
}

interface CfCtx {
  visited: Map<number, number>; // modId -> installed fileId
  titles: Map<number, string>;
}

async function installCfFile(
  cfg: PrismConfig,
  instanceId: string,
  modsDir: string,
  mod: CfMod,
  file: CfFile,
  out: CfInstallOutcome,
  ctx: CfCtx,
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
        ctx.visited.set(mod.id, file.id);
        await installDeps(cfg, instanceId, modsDir, file, out, ctx, depth);
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
  const target = path.join(modsDir, file.fileName);
  if (expected && fs.existsSync(target) && sha1(fs.readFileSync(target)) === expected) {
    out.installed.push({ mod: mod.name, file: file.fileName, via: "already-present" });
  } else {
    const buf = await downloadVerified(file.downloadUrl as string, expected);
    if (fs.existsSync(target)) backupFiles(cfg, [target]);
    fs.writeFileSync(target, buf);
    writeCfIndexFile(path.join(modsDir, ".index"), mod.slug, file.fileName, file, mod.id, file.downloadUrl as string);
    out.installed.push({ mod: mod.name, file: file.fileName });
  }
  ctx.visited.set(mod.id, file.id);
  await installDeps(cfg, instanceId, modsDir, file, out, ctx, depth);
}

async function cfTitle(cfg: PrismConfig, ctx: CfCtx, modId: number): Promise<string> {
  const hit = ctx.titles.get(modId);
  if (hit) return hit;
  let name = String(modId);
  try {
    name = (await cfFetch<CfMod>(cfg, `/mods/${modId}`)).name;
  } catch {
    /* keep the id as the name */
  }
  ctx.titles.set(modId, name);
  return name;
}

async function installDeps(
  cfg: PrismConfig,
  instanceId: string,
  modsDir: string,
  file: CfFile,
  out: CfInstallOutcome,
  ctx: CfCtx,
  depth: number,
): Promise<void> {
  if (depth >= 4) return;
  const { getInstance } = await import("./instances.js");
  const inst = getInstance(cfg, instanceId);
  for (const dep of file.dependencies) {
    if (dep.relationType === 5) {
      // Declared incompatible: collect for the post-install presence check.
      if (!out.declaredIncompatibles.some((d) => d.modId === dep.modId)) {
        out.declaredIncompatibles.push({ modId: dep.modId, name: await cfTitle(cfg, ctx, dep.modId) });
      }
      continue;
    }
    if (dep.relationType !== 3) {
      if (dep.relationType === 2) out.skippedOptionalDeps.push(String(dep.modId));
      continue; // 1 embedded / 4 tool / 6 include: nothing to install
    }
    const keptFileId = ctx.visited.get(dep.modId);
    if (keptFileId !== undefined) {
      if (dep.fileId && dep.fileId !== keptFileId) {
        out.dependencyConflicts.push({ modId: dep.modId, keptFileId, requestedFileId: dep.fileId });
      }
      continue;
    }
    try {
      const depMod = await cfFetch<CfMod>(cfg, `/mods/${dep.modId}`);
      ctx.titles.set(dep.modId, depMod.name);
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
      await installCfFile(cfg, instanceId, modsDir, depMod, depFile, out, ctx, depth + 1);
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
  const out: CfInstallOutcome = {
    installed: [],
    blocked: [],
    skippedOptionalDeps: [],
    unresolvedDeps: [],
    declaredIncompatibles: [],
    incompatibleWarnings: [],
    dependencyConflicts: [],
  };
  const ctx: CfCtx = { visited: new Map(), titles: new Map() };
  await installCfFile(cfg, instanceId, modsDir, mod, file, out, ctx, 0);
  const installedIds = readInstalledIds(modsDir);
  out.incompatibleWarnings = out.declaredIncompatibles.filter((d) => installedIds.has(String(d.modId)));
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

// ---- CurseForge modpack (.zip) import ----

export interface CfManifest {
  minecraft: { version: string; modLoaders: { id: string; primary: boolean }[] };
  name: string;
  version?: string;
  files: { projectID: number; fileID: number; required: boolean }[];
  overrides?: string;
}

// "forge-47.4.28" -> { loader: "forge", version: "47.4.28" }
export function parseCfLoader(id: string): { loader: string; version: string } {
  const dash = id.indexOf("-");
  if (dash < 0) return { loader: id.toLowerCase(), version: "" };
  return { loader: id.slice(0, dash).toLowerCase(), version: id.slice(dash + 1) };
}

export async function importModpackCf(cfg: PrismConfig, zipPath: string, nameOverride?: string) {
  requireWritable(cfg);
  if (!fs.existsSync(zipPath)) throw new Error(`pack zip not found: ${zipPath}`);
  const zip = new AdmZip(zipPath);
  const manifestEntry =
    zip.getEntry("manifest.json") ??
    zip.getEntries().find((e) => /(^|\/)manifest\.json$/.test(e.entryName) && !e.entryName.includes("overrides"));
  if (!manifestEntry) throw new Error("manifest.json missing - not a CurseForge pack zip");
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as CfManifest;
  if (!manifest.minecraft?.version) throw new Error("manifest has no minecraft.version");

  const primaryLoader = manifest.minecraft.modLoaders.find((l) => l.primary) ?? manifest.minecraft.modLoaders[0];
  const parsed = primaryLoader ? parseCfLoader(primaryLoader.id) : undefined;
  const { createInstance } = await import("./instances.js");
  const created = await createInstance(cfg, {
    name: nameOverride ?? manifest.name,
    mcVersion: manifest.minecraft.version,
    loader: parsed?.loader,
    loaderVersion: parsed?.version || undefined,
  });
  const instDir = instanceDir(cfg.dataDir, created.id);
  const mcDir = path.join(instDir, "minecraft");
  const modsDir = path.join(mcDir, "mods");
  fs.mkdirSync(modsDir, { recursive: true });

  const out: CfInstallOutcome = {
    installed: [],
    blocked: [],
    skippedOptionalDeps: [],
    unresolvedDeps: [],
    declaredIncompatibles: [],
    incompatibleWarnings: [],
    dependencyConflicts: [],
  };
  const ctx: CfCtx = { visited: new Map(), titles: new Map() };
  const skippedOptional: string[] = [];

  const entries = manifest.files;
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        if (entry.required === false) {
          skippedOptional.push(`project ${entry.projectID} (optional in pack)`);
          continue;
        }
        const mod = await cfFetch<CfMod>(cfg, `/mods/${entry.projectID}`);
        ctx.titles.set(mod.id, mod.name);
        const file = await cfFetch<CfFile>(cfg, `/mods/${entry.projectID}/files/${entry.fileID}`);
        if (ctx.visited.get(mod.id) === file.id) continue;
        await installCfFile(cfg, created.id, modsDir, mod, file, out, ctx, 0);
      } catch (e) {
        out.unresolvedDeps.push(`project ${entry.projectID}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // Overrides: the pack's overrides folder goes into the instance minecraft dir.
  const overridesRoot = (manifest.overrides ?? "overrides").replace(/\/$/, "");
  let overrideFiles = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    if (!e.entryName.startsWith(overridesRoot + "/")) continue;
    const rel = e.entryName.slice(overridesRoot.length + 1);
    const dest = path.join(mcDir, ...rel.split("/"));
    if (!dest.startsWith(mcDir)) continue; // path traversal guard
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.getData());
    overrideFiles++;
  }

  const status = out.blocked.length === 0 ? "installed" : out.installed.length === 0 ? "blocked" : "partial_blocked";
  audit(cfg, "import_modpack_cf", created.id, {
    zip: zipPath,
    files: entries.length,
    installed: out.installed.length,
    blocked: out.blocked.map((b) => b.fileName),
    overrideFiles,
  });
  return {
    instance: created.id,
    name: manifest.name,
    packVersion: manifest.version,
    mcVersion: manifest.minecraft.version,
    loader: parsed ? `${parsed.loader} ${parsed.version}` : undefined,
    status,
    installedCount: out.installed.length,
    installed: out.installed,
    blocked: out.blocked,
    skippedOptional,
    unresolved: out.unresolvedDeps,
    overrideFiles,
    ...(out.incompatibleWarnings.length ? { incompatibleWarnings: out.incompatibleWarnings } : {}),
  };
}

// ---- update check / update for CF-installed mods ----

export interface CfIndexEntry {
  slug: string;
  fileName: string;
  fileId: number;
  projectId: number;
}

export function parseCfIndex(text: string, slug: string): CfIndexEntry | undefined {
  const section = /\[update\.curseforge\]([\s\S]*)$/.exec(text);
  if (!section) return undefined;
  const fileId = /file-id\s*=\s*(\d+)/.exec(section[1]);
  const projectId = /project-id\s*=\s*(\d+)/.exec(section[1]);
  const fileName = /^filename\s*=\s*"([^"]+)"/m.exec(text);
  if (!fileId || !projectId || !fileName) return undefined;
  return { slug, fileName: fileName[1], fileId: Number(fileId[1]), projectId: Number(projectId[1]) };
}

export function readCfIndexEntries(modsDir: string): CfIndexEntry[] {
  const indexDir = path.join(modsDir, ".index");
  if (!fs.existsSync(indexDir)) return [];
  const out: CfIndexEntry[] = [];
  for (const name of fs.readdirSync(indexDir)) {
    if (!name.endsWith(".pw.toml")) continue;
    const entry = parseCfIndex(fs.readFileSync(path.join(indexDir, name), "utf8"), name.replace(/\.pw\.toml$/, ""));
    if (entry) out.push(entry);
  }
  return out;
}

export async function checkModUpdatesCf(cfg: PrismConfig, instanceId: string) {
  const modsDir = path.join(instanceDir(cfg.dataDir, instanceId), "minecraft", "mods");
  const entries = readCfIndexEntries(modsDir);
  const { getInstance } = await import("./instances.js");
  const inst = getInstance(cfg, instanceId);
  const updates: unknown[] = [];
  let upToDate = 0;
  for (const entry of entries) {
    const files = await fetchFilesFiltered(cfg, entry.projectId, inst.mcVersion, inst.loader);
    const picked = selectCfFile(files, inst.mcVersion, inst.loader);
    if (!picked) {
      updates.push({ slug: entry.slug, projectId: entry.projectId, problem: "no file matches this instance anymore" });
      continue;
    }
    if (picked.id === entry.fileId || isCfPickDowngrade(files, entry.fileId, picked)) {
      upToDate++;
      continue;
    }
    let modName = entry.slug;
    try {
      modName = (await cfFetch<CfMod>(cfg, `/mods/${entry.projectId}`)).name;
    } catch {
      /* keep slug */
    }
    updates.push({
      slug: entry.slug,
      projectId: entry.projectId,
      mod: modName,
      currentFileId: entry.fileId,
      currentFile: entry.fileName,
      latestFileId: picked.id,
      latestFile: picked.fileName,
      latestType: cfReleaseLabel(picked.releaseType),
      blocked: isBlocked(picked),
    });
  }
  // Jars with no index entry (typically bundled inside modpacks) can still
  // be identified as CurseForge files by fingerprint; check those too and
  // flag the updates as unmanaged (update_mod_cf converts them to managed
  // by writing an index entry when it applies the update).
  let fingerprinted = 0;
  try {
    const covered = new Set(entries.map((e) => e.fileName));
    const jars = fs.existsSync(modsDir)
      ? fs.readdirSync(modsDir).filter((f) => (f.endsWith(".jar") || f.endsWith(".jar.disabled")) && !covered.has(f.replace(/\.disabled$/, "")))
      : [];
    const hits = await lookupCfFingerprints(cfg, modsDir, jars);
    fingerprinted = hits.length;
    if (hits.length > 0) {
      const mods = await getCfModsByIds(cfg, [...new Set(hits.map((h) => h.modId))]);
      const slugById = new Map(mods.map((m) => [m.id, m.slug]));
      const nameById = new Map(mods.map((m) => [m.id, m.name]));
      for (const hit of hits) {
        const files = await fetchFilesFiltered(cfg, hit.modId, inst.mcVersion, inst.loader);
        const picked = selectCfFile(files, inst.mcVersion, inst.loader);
        if (!picked) continue;
        if (picked.id === hit.fileId || isCfPickDowngrade(files, hit.fileId, picked)) {
          upToDate++;
          continue;
        }
        updates.push({
          slug: slugById.get(hit.modId) ?? String(hit.modId),
          projectId: hit.modId,
          mod: nameById.get(hit.modId) ?? slugById.get(hit.modId) ?? String(hit.modId),
          currentFileId: hit.fileId,
          currentFile: hit.file,
          latestFileId: picked.id,
          latestFile: picked.fileName,
          latestType: cfReleaseLabel(picked.releaseType),
          blocked: isBlocked(picked),
          viaFingerprint: true,
          managed: false,
        });
      }
    }
  } catch {
    // Fingerprinting is best-effort; the index-based result stands.
  }
  return { instance: instanceId, checked: entries.length, fingerprinted, upToDate, updates };
}

export async function updateModCf(cfg: PrismConfig, instanceId: string, slugOrProjectId: string) {
  requireWritable(cfg);
  const modsDir = path.join(instanceDir(cfg.dataDir, instanceId), "minecraft", "mods");
  const entries = readCfIndexEntries(modsDir);
  let entry = entries.find((e) => e.slug === slugOrProjectId) ?? entries.find((e) => String(e.projectId) === slugOrProjectId);
  if (!entry) {
    // Not index-managed: try identifying an unmanaged jar by fingerprint
    // (modpack-bundled CurseForge files). Installing the update writes an
    // index entry, converting the mod to managed from then on.
    const jars = fs.existsSync(modsDir)
      ? fs.readdirSync(modsDir).filter((f) => f.endsWith(".jar") || f.endsWith(".jar.disabled"))
      : [];
    const hits = await lookupCfFingerprints(cfg, modsDir, jars);
    if (hits.length > 0) {
      const mods = await getCfModsByIds(cfg, [...new Set(hits.map((h) => h.modId))]);
      const slugById = new Map(mods.map((m) => [m.id, m.slug]));
      const hit = hits.find(
        (h) => slugById.get(h.modId) === slugOrProjectId || String(h.modId) === slugOrProjectId,
      );
      if (hit) {
        entry = { slug: slugById.get(hit.modId) ?? String(hit.modId), fileName: hit.file, fileId: hit.fileId, projectId: hit.modId };
      }
    }
  }
  if (!entry) throw new Error(`no CurseForge-installed mod matches: ${slugOrProjectId}`);
  const result = await installModCf(cfg, instanceId, { modId: entry.projectId });
  const newFile = result.installed.find((i) => i.file !== entry.fileName)?.file ?? result.installed[0]?.file;
  let removedOld: string | undefined;
  if (newFile && newFile !== entry.fileName) {
    const oldPath = path.join(modsDir, entry.fileName);
    if (fs.existsSync(oldPath)) {
      backupFiles(cfg, [oldPath]);
      fs.rmSync(oldPath);
      removedOld = entry.fileName;
    }
  }
  audit(cfg, "update_mod_cf", instanceId, { slug: entry.slug, from: entry.fileId, removedOld });
  return { slug: entry.slug, previousFile: entry.fileName, removedOld, ...result };
}
