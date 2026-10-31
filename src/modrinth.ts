import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { instanceDir, type PrismConfig } from "./config.js";
import { audit, backupFiles, requireConfirm, requireWritable } from "./safety.js";

// Modrinth API v2 (no key required). Install writes the jar into the right
// subfolder and a packwiz-style index file into .index/<slug>.pw.toml so the
// Prism UI shows provider/version correctly (PLAN.md §1.3).

const API = "https://api.modrinth.com/v2";
const UA = "prismlauncher-mcp/0.1.0 (https://github.com/PrismLauncher)";

export type ResourceType = "mod" | "resourcepack" | "shader" | "datapack";

const TYPE_DIR: Record<ResourceType, { projectType: string; dir: string }> = {
  mod: { projectType: "mod", dir: "mods" },
  resourcepack: { projectType: "resourcepack", dir: "resourcepacks" },
  shader: { projectType: "shader", dir: "shaderpacks" },
  datapack: { projectType: "datapack", dir: "datapacks" },
};

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Modrinth API ${res.status}: ${url}`);
  return (await res.json()) as T;
}

export interface SearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  versions: string[];
}

export async function searchMods(
  query: string,
  opts: { loader?: string; mcVersion?: string; type?: ResourceType; limit?: number } = {},
): Promise<SearchHit[]> {
  const facets: string[][] = [[`project_type:${TYPE_DIR[opts.type ?? "mod"].projectType}`]];
  if (opts.mcVersion) facets.push([`versions:${opts.mcVersion}`]);
  if (opts.loader) facets.push([`categories:${opts.loader}`]);
  const q = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    limit: String(opts.limit ?? 10),
  });
  const data = await api<{ hits: SearchHit[] }>(`${API}/search?${q}`);
  return data.hits.map((h) => ({
    project_id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    downloads: h.downloads,
    versions: h.versions,
  }));
}

interface MrVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type: string;
  game_versions: string[];
  date_published?: string;
  loaders: string[];
  files: Array<{ url: string; filename: string; primary: boolean; hashes: { sha1: string; sha512: string } }>;
  dependencies: Array<{ project_id: string; version_id?: string; dependency_type: string; file_name?: string }>;
}

async function getProject(idOrSlug: string) {
  return api<{ id: string; slug: string; title: string }>(`${API}/project/${idOrSlug}`);
}

async function listProjectVersions(id: string): Promise<MrVersion[]> {
  return api<MrVersion[]>(`${API}/project/${id}/version`);
}

function pickVersion(versions: MrVersion[], mcVersion?: string, loader?: string): MrVersion {
  let pool = versions;
  if (mcVersion) pool = pool.filter((v) => v.game_versions.includes(mcVersion));
  if (loader) pool = pool.filter((v) => v.loaders.includes(loader));
  if (pool.length === 0) throw new Error("no Modrinth version matches the instance (mc/loader)");
  const stable = pool.filter((v) => v.version_type === "release");
  return (stable[0] ?? pool[0])!;
}

function sha1(buf: Buffer): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function writeIndexFile(indexDir: string, slug: string, filename: string, file: MrVersion["files"][number], projectId: string, versionId: string): void {
  fs.mkdirSync(indexDir, { recursive: true });
  const toml = [
    `name = ${JSON.stringify(slug)}`,
    `filename = ${JSON.stringify(filename)}`,
    `side = "both"`,
    ``,
    `[download]`,
    `url = ${JSON.stringify(file.url)}`,
    `hash-format = "sha1"`,
    `hash = ${JSON.stringify(file.hashes.sha1)}`,
    ``,
    `[update]`,
    `[update.modrinth]`,
    `mod-id = ${JSON.stringify(projectId)}`,
    `version = ${JSON.stringify(versionId)}`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(indexDir, `${slug}.pw.toml`), toml, "utf8");
}


// ---- installed index + dependency bookkeeping (shared with curseforge.ts) ----

export interface InstalledId {
  source: "modrinth" | "curseforge";
  indexFile: string;
}

// Map of project id (Modrinth id, or CurseForge project id as a string) for
// every mod recorded in mods/.index/*.pw.toml.
export function readInstalledIds(modsDir: string): Map<string, InstalledId> {
  const out = new Map<string, InstalledId>();
  const indexDir = path.join(modsDir, ".index");
  if (!fs.existsSync(indexDir)) return out;
  for (const name of fs.readdirSync(indexDir)) {
    if (!name.endsWith(".pw.toml")) continue;
    const text = fs.readFileSync(path.join(indexDir, name), "utf8");
    const mr = /\[update\.modrinth\][\s\S]*?mod-id\s*=\s*"([^"]+)"/.exec(text);
    if (mr) out.set(mr[1], { source: "modrinth", indexFile: name });
    const cf = /\[update\.curseforge\][\s\S]*?project-id\s*=\s*(\d+)/.exec(text);
    if (cf) out.set(cf[1], { source: "curseforge", indexFile: name });
  }
  return out;
}

export type DepAction = "install" | "skip" | "conflict";

// Decide what to do with a required dependency that was already installed
// earlier in the same install run.
export function classifyDep(seenVersionId: string | undefined, requestedVersionId?: string): DepAction {
  if (seenVersionId === undefined) return "install";
  if (requestedVersionId && requestedVersionId !== seenVersionId) return "conflict";
  return "skip";
}

export interface DepContext {
  visited: Map<string, { versionId: string; versionNumber: string }>;
  conflicts: { project: string; keptVersion: string; requestedVersionId: string }[];
  declaredIncompatibles: Map<string, string>;
  titles: Map<string, string>;
}

export interface InstallResult {
  project: string;
  version: string;
  file: string;
  installedDeps: InstallResult[];
  skippedOptionalDeps: string[];
  alreadyPresent?: boolean;
  note?: string;
}

async function installOne(
  cfg: PrismConfig,
  instDir: string,
  type: ResourceType,
  projectRef: string,
  mcVersion?: string,
  loader?: string,
  versionId?: string,
  depth = 0,
  ctx?: DepContext,
): Promise<InstallResult> {
  const project = await getProject(projectRef);
  const versions = await listProjectVersions(project.id);
  const version = versionId
    ? versions.find((v) => v.id === versionId) ?? (() => { throw new Error(`version ${versionId} not found`); })()
    : pickVersion(versions, mcVersion, loader);
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) throw new Error(`version ${version.version_number} has no files`);

  const targetDirName = TYPE_DIR[type].dir;
  const targetDir = type === "mod" ? path.join(instDir, "minecraft", targetDirName) : path.join(instDir, "minecraft", targetDirName);
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, file.filename);

  // On-disk dedupe: the identical file is already installed -> no download.
  let alreadyPresent = false;
  if (fs.existsSync(targetPath) && sha1(fs.readFileSync(targetPath)) === file.hashes.sha1) {
    alreadyPresent = true;
  } else {
    const res = await fetch(file.url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`download failed HTTP ${res.status}: ${file.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const digest = sha1(buf);
    if (digest !== file.hashes.sha1) throw new Error(`sha1 mismatch for ${file.filename}: got ${digest}`);
    if (fs.existsSync(targetPath)) backupFiles(cfg, [targetPath]);
    fs.writeFileSync(targetPath, buf);
  }
  if (type === "mod") {
    writeIndexFile(path.join(targetDir, ".index"), project.slug, file.filename, file, project.id, version.id);
  }
  ctx?.visited.set(project.id, { versionId: version.id, versionNumber: version.version_number });

  const installedDeps: InstallResult[] = [];
  const skippedOptionalDeps: string[] = [];
  if (depth < 4) {
    for (const dep of version.dependencies) {
      if (dep.dependency_type === "required") {
        const action = ctx ? classifyDep(ctx.visited.get(dep.project_id)?.versionId, dep.version_id) : "install";
        if (action === "skip") continue;
        if (action === "conflict" && ctx) {
          const kept = ctx.visited.get(dep.project_id);
          ctx.conflicts.push({
            project: dep.project_id,
            keptVersion: kept?.versionNumber ?? "unknown",
            requestedVersionId: dep.version_id as string,
          });
          continue;
        }
        installedDeps.push(
          await installOne(cfg, instDir, type, dep.project_id, mcVersion, loader, dep.version_id, depth + 1, ctx),
        );
      } else if (dep.dependency_type === "optional") {
        skippedOptionalDeps.push(dep.project_id);
      } else if (dep.dependency_type === "incompatible" && ctx) {
        if (!ctx.declaredIncompatibles.has(dep.project_id)) {
          let title = ctx.titles.get(dep.project_id);
          if (!title) {
            try {
              title = (await getProject(dep.project_id)).title;
            } catch {
              title = dep.project_id;
            }
            ctx.titles.set(dep.project_id, title);
          }
          ctx.declaredIncompatibles.set(dep.project_id, title);
        }
      }
    }
  }

  return {
    project: project.title,
    version: version.version_number,
    file: file.filename,
    installedDeps,
    skippedOptionalDeps,
    ...(alreadyPresent ? { alreadyPresent: true } : {}),
  };
}


export interface VersionListing {
  id: string;
  versionNumber: string;
  name: string;
  type: string;
  datePublished?: string;
  fileName?: string;
  matchesInstance: boolean;
}

export function annotateVersions(versions: MrVersion[], mcVersion?: string, loader?: string): VersionListing[] {
  return versions.map((v) => ({
    id: v.id,
    versionNumber: v.version_number,
    name: v.name,
    type: v.version_type,
    datePublished: v.date_published,
    fileName: (v.files.find((f) => f.primary) ?? v.files[0])?.filename,
    matchesInstance:
      (!mcVersion || v.game_versions.includes(mcVersion)) && (!loader || v.loaders.includes(loader)),
  }));
}

export async function listModVersions(cfg: PrismConfig, projectRef: string, instanceId?: string) {
  const project = await getProject(projectRef);
  const versions = await listProjectVersions(project.id);
  let mcVersion: string | undefined;
  let loader: string | undefined;
  if (instanceId) {
    const { getInstance } = await import("./instances.js");
    const inst = getInstance(cfg, instanceId);
    mcVersion = inst.mcVersion;
    loader = inst.loader;
  }
  const listings = annotateVersions(versions, mcVersion, loader);
  return {
    project: project.title,
    slug: project.slug,
    autoPick: listings.find((l) => l.matchesInstance && l.type === "release") ?? listings.find((l) => l.matchesInstance),
    versions: listings.slice(0, 50),
    note: "Install a specific version with install_mod's versionId (for rollback when a release is buggy).",
  };
}

export async function installMod(
  cfg: PrismConfig,
  instanceId: string,
  projectRef: string,
  opts: { type?: ResourceType; versionId?: string } = {},
): Promise<InstallResult> {
  requireWritable(cfg);
  const instDir = instanceDir(cfg.dataDir, instanceId);
  if (!fs.existsSync(instDir)) throw new Error(`instance not found: ${instanceId}`);
  // Instance mc/loader for version matching.
  const { getInstance } = await import("./instances.js");
  const inst = getInstance(cfg, instanceId);
  const ctx: DepContext = {
    visited: new Map(),
    conflicts: [],
    declaredIncompatibles: new Map(),
    titles: new Map(),
  };
  const result = await installOne(
    cfg,
    instDir,
    opts.type ?? "mod",
    projectRef,
    inst.mcVersion,
    inst.loader,
    opts.versionId,
    0,
    ctx,
  );
  const modsDir = path.join(instDir, "minecraft", "mods");
  const installedIds = readInstalledIds(modsDir);
  const declaredIncompatibles = [...ctx.declaredIncompatibles].map(([id, name]) => ({ id, name }));
  const incompatibleWarnings = declaredIncompatibles.filter((d) => installedIds.has(d.id));
  audit(cfg, "install_mod", instanceId, { projectRef, ...opts, result: result.file });
  return {
    ...result,
    ...(ctx.conflicts.length ? { dependencyConflicts: ctx.conflicts } : {}),
    ...(declaredIncompatibles.length ? { declaredIncompatibles } : {}),
    ...(incompatibleWarnings.length ? { incompatibleWarnings } : {}),
  };
}

export function listMods(cfg: PrismConfig, instanceId: string) {
  const modsDir = path.join(instanceDir(cfg.dataDir, instanceId), "minecraft", "mods");
  if (!fs.existsSync(modsDir)) return [];
  return fs
    .readdirSync(modsDir)
    .filter((f) => f.endsWith(".jar") || f.endsWith(".jar.disabled"))
    .sort()
    .map((f) => ({ file: f, enabled: !f.endsWith(".disabled") }));
}

function modsDir(cfg: PrismConfig, instanceId: string): string {
  return path.join(instanceDir(cfg.dataDir, instanceId), "minecraft", "mods");
}

function resolveModFile(cfg: PrismConfig, instanceId: string, file: string): string {
  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    throw new Error("invalid mod file name");
  }
  const p = path.join(modsDir(cfg, instanceId), file);
  if (!fs.existsSync(p)) throw new Error(`mod file not found: ${file}`);
  return p;
}

export function removeMod(cfg: PrismConfig, instanceId: string, file: string, confirm?: boolean) {
  requireWritable(cfg);
  requireConfirm("remove_mod", confirm);
  const p = resolveModFile(cfg, instanceId, file);
  backupFiles(cfg, [p]);
  fs.rmSync(p);
  // Drop the packwiz index entry too, so Prism does not show a ghost.
  const slug = file.replace(/\.jar(\.disabled)?$/, "");
  const indexDir = path.join(modsDir(cfg, instanceId), ".index");
  if (fs.existsSync(indexDir)) {
    for (const f of fs.readdirSync(indexDir)) {
      if (f.endsWith(".pw.toml")) {
        const content = fs.readFileSync(path.join(indexDir, f), "utf8");
        if (content.includes(`filename = "${file.replace(/\.disabled$/, "")}"`)) {
          fs.rmSync(path.join(indexDir, f));
        }
      }
    }
  }
  audit(cfg, "remove_mod", instanceId, { file });
  return { removed: file, instance: instanceId, slug };
}

export function setModEnabled(cfg: PrismConfig, instanceId: string, file: string, enabled: boolean) {
  requireWritable(cfg);
  const p = resolveModFile(cfg, instanceId, file);
  const isDisabled = p.endsWith(".disabled");
  if (enabled === !isDisabled) return { file, enabled, changed: false };
  const dest = enabled ? p.slice(0, -".disabled".length) : p + ".disabled";
  fs.renameSync(p, dest);
  audit(cfg, "set_mod_enabled", instanceId, { file, enabled });
  return { file: path.basename(dest), enabled, changed: true };
}

interface VersionFileHit {
  project_id: string;
  id: string;
  version_number: string;
  date_published: string;
}

export async function checkModUpdates(cfg: PrismConfig, instanceId: string) {
  const dir = modsDir(cfg, instanceId);
  if (!fs.existsSync(dir)) return [];
  const { getInstance } = await import("./instances.js");
  const inst = getInstance(cfg, instanceId);
  const jars = fs.readdirSync(dir).filter((f) => f.endsWith(".jar"));
  const hashes = new Map<string, string>();
  for (const jar of jars) {
    hashes.set(sha1(fs.readFileSync(path.join(dir, jar))), jar);
  }
  if (hashes.size === 0) return [];
  const res = await fetch(`${API}/version_files`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json" },
    body: JSON.stringify({ hashes: [...hashes.keys()], algorithm: "sha1" }),
  });
  if (!res.ok) throw new Error(`Modrinth version_files -> HTTP ${res.status}`);
  const byHash = (await res.json()) as Record<string, VersionFileHit>;
  const report: Array<Record<string, unknown>> = [];
  for (const [hash, jar] of hashes) {
    const current = byHash[hash];
    if (!current) {
      report.push({ file: jar, known: false });
      continue;
    }
    const versions = await listProjectVersions(current.project_id);
    const matching = versions.filter(
      (v) =>
        (!inst.mcVersion || v.game_versions.includes(inst.mcVersion)) &&
        (!inst.loader || v.loaders.includes(inst.loader)),
    );
    // Same rule as install/update: prefer the newest RELEASE build; a newer
    // beta must never be silently reported as "the update". Surface it
    // separately as newerPrerelease so the caller decides knowingly.
    let latest: MrVersion | undefined;
    try {
      latest = pickVersion(matching, inst.mcVersion, inst.loader);
    } catch {
      latest = undefined;
    }
    const newestOverall = matching[0];
    report.push({
      file: jar,
      known: true,
      project: current.project_id,
      currentVersion: current.version_number,
      latestVersion: latest?.version_number,
      updateAvailable: !!latest && latest.id !== current.id,
      newerPrerelease:
        newestOverall && latest && newestOverall.id !== latest.id && newestOverall.id !== current.id
          ? newestOverall.version_number
          : undefined,
    });
  }
  return report;
}

export async function updateMod(cfg: PrismConfig, instanceId: string, file: string) {
  requireWritable(cfg);
  const dir = modsDir(cfg, instanceId);
  const p = resolveModFile(cfg, instanceId, file.replace(/\.disabled$/, ""));
  const hash = sha1(fs.readFileSync(p));
  const res = await fetch(`${API}/version_files`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json" },
    body: JSON.stringify({ hashes: [hash], algorithm: "sha1" }),
  });
  if (!res.ok) throw new Error(`Modrinth version_files -> HTTP ${res.status}`);
  const byHash = (await res.json()) as Record<string, VersionFileHit>;
  const current = byHash[hash];
  if (!current) throw new Error(`${file} is not a known Modrinth file; cannot update`);
  const { getInstance } = await import("./instances.js");
  const inst = getInstance(cfg, instanceId);
  const versions = await listProjectVersions(current.project_id);
  const latest = pickVersion(versions, inst.mcVersion, inst.loader);
  if (latest.id === current.id) {
    return { file, updated: false, version: current.version_number };
  }
  // Install the new version first, then remove the old jar (backed up).
  const result = await installOne(
    cfg,
    instanceDir(cfg.dataDir, instanceId),
    "mod",
    current.project_id,
    inst.mcVersion,
    inst.loader,
    latest.id,
  );
  if (result.file !== path.basename(p)) {
    backupFiles(cfg, [p]);
    fs.rmSync(p);
  }
  audit(cfg, "update_mod", instanceId, { file, from: current.version_number, to: latest.version_number });
  return {
    file,
    updated: true,
    fromVersion: current.version_number,
    toVersion: latest.version_number,
    newFile: result.file,
  };
}
