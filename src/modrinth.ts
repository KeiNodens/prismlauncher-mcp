import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { instanceDir, type PrismConfig } from "./config.js";
import { audit, backupFiles, requireWritable } from "./safety.js";

// Modrinth API v2 (no key required). Install writes the jar into the right
// subfolder and a packwiz-style index file into .index/<slug>.pw.toml so the
// Prism UI shows provider/version correctly (PLAN.md §1.3).

const API = "https://api.modrinth.com/v2";
const UA = "prism-mcp/0.1.0 (https://github.com/PrismLauncher)";

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

export interface InstallResult {
  project: string;
  version: string;
  file: string;
  installedDeps: InstallResult[];
  skippedOptionalDeps: string[];
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

  const res = await fetch(file.url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`download failed HTTP ${res.status}: ${file.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const digest = sha1(buf);
  if (digest !== file.hashes.sha1) throw new Error(`sha1 mismatch for ${file.filename}: got ${digest}`);

  if (fs.existsSync(targetPath)) backupFiles(cfg, [targetPath]);
  fs.writeFileSync(targetPath, buf);
  if (type === "mod") {
    writeIndexFile(path.join(targetDir, ".index"), project.slug, file.filename, file, project.id, version.id);
  }

  const installedDeps: InstallResult[] = [];
  const skippedOptionalDeps: string[] = [];
  if (depth < 4) {
    for (const dep of version.dependencies) {
      if (dep.dependency_type === "required") {
        installedDeps.push(
          await installOne(cfg, instDir, type, dep.project_id, mcVersion, loader, dep.version_id, depth + 1),
        );
      } else if (dep.dependency_type === "optional") {
        skippedOptionalDeps.push(dep.project_id);
      }
    }
  }

  return {
    project: project.title,
    version: version.version_number,
    file: file.filename,
    installedDeps,
    skippedOptionalDeps,
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
  const result = await installOne(
    cfg,
    instDir,
    opts.type ?? "mod",
    projectRef,
    inst.mcVersion,
    inst.loader,
    opts.versionId,
  );
  audit(cfg, "install_mod", instanceId, { projectRef, ...opts, result: result.file });
  return result;
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
