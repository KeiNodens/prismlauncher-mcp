import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { instanceDir, type PrismConfig } from "./config.js";
import { readCfIndexEntries, searchModsCf } from "./curseforge.js";
import { removeMod } from "./modrinth.js";
import { requireConfirm, requireWritable } from "./safety.js";

// Cross-source mod identity: a mod published on BOTH CurseForge and Modrinth
// is tracked per source (Modrinth by file sha1, CurseForge by the packwiz
// .index), so each side's view can miss or duplicate the other side's copy.
// These helpers join the two inventories by project slug — dual-published
// authors overwhelmingly use the same slug on both platforms — and report
// (and optionally resolve) the overlap. Slug equality is the only matching
// rule; nothing is guessed from names or filenames.

const MR_API = "https://api.modrinth.com/v2";
const MR_UA = "prismlauncher-mcp/0.1.0 (https://github.com/PrismLauncher)";

function sha1(buf: Buffer): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

interface MrVersionFileHit {
  project_id: string;
  version_number: string;
}

interface MrProject {
  id: string;
  slug: string;
  title: string;
}

async function mrGet<T>(p: string): Promise<T | null> {
  const res = await fetch(`${MR_API}${p}`, { headers: { "User-Agent": MR_UA } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Modrinth ${p} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface CrossModEntry {
  slug: string;
  name?: string;
  modrinth?: { projectId: string; files: { file: string; version?: string }[] };
  curseforge?: { projectId: number; file?: string; fileId?: number };
}

export async function crossCheckMods(cfg: PrismConfig, instanceId: string) {
  const dir = path.join(instanceDir(cfg.dataDir, instanceId), "minecraft", "mods");
  const jars = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".jar") || f.endsWith(".jar.disabled"))
    : [];

  // Modrinth inventory: identify every jar by sha1.
  const hashToFile = new Map<string, string>();
  for (const jar of jars) hashToFile.set(sha1(fs.readFileSync(path.join(dir, jar))), jar);
  let byHash: Record<string, MrVersionFileHit> = {};
  if (hashToFile.size > 0) {
    const res = await fetch(`${MR_API}/version_files`, {
      method: "POST",
      headers: { "User-Agent": MR_UA, "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: [...hashToFile.keys()], algorithm: "sha1" }),
    });
    if (!res.ok) throw new Error(`Modrinth version_files -> HTTP ${res.status}`);
    byHash = (await res.json()) as Record<string, MrVersionFileHit>;
  }
  const projectIds = [...new Set(Object.values(byHash).map((h) => h.project_id))];
  const projects = new Map<string, MrProject>();
  if (projectIds.length > 0) {
    const list = await mrGet<MrProject[]>(`/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`);
    for (const p of list ?? []) projects.set(p.id, p);
  }
  // A slug can have several Modrinth-known files (multiple versions on
  // disk), so keep them all.
  const mrBySlug = new Map<string, { projectId: string; title: string; files: { file: string; version?: string }[] }>();
  const knownFiles = new Set<string>();
  for (const [hash, file] of hashToFile) {
    const hit = byHash[hash];
    if (!hit) continue;
    knownFiles.add(file);
    const proj = projects.get(hit.project_id);
    if (!proj) continue;
    const entry = mrBySlug.get(proj.slug) ?? { projectId: proj.id, title: proj.title, files: [] };
    entry.files.push({ file, version: hit.version_number });
    mrBySlug.set(proj.slug, entry);
  }

  // CurseForge inventory: the packwiz .index entries Prism/MCP installs write.
  const cfBySlug = new Map<string, CrossModEntry["curseforge"]>();
  for (const e of readCfIndexEntries(dir)) {
    const onDisk = fs.existsSync(path.join(dir, e.fileName))
      ? e.fileName
      : fs.existsSync(path.join(dir, e.fileName + ".disabled"))
        ? e.fileName + ".disabled"
        : e.fileName;
    cfBySlug.set(e.slug, { projectId: e.projectId, file: onDisk, fileId: e.fileId });
    knownFiles.add(onDisk);
    knownFiles.add(e.fileName);
  }

  const bothInstalled: CrossModEntry[] = [];
  const dualTracked: CrossModEntry[] = [];
  const availableOnBoth: CrossModEntry[] = [];
  const curseforgeOnly: CrossModEntry[] = [];
  const modrinthOnly: CrossModEntry[] = [];
  const stripDisabled = (f?: string) => f?.replace(/\.disabled$/, "");
  const slugs = new Set([...cfBySlug.keys(), ...mrBySlug.keys()]);
  for (const slug of slugs) {
    const cf = cfBySlug.get(slug);
    const mr = mrBySlug.get(slug);
    if (cf && mr) {
      const entry: CrossModEntry = {
        slug,
        name: mr.title,
        modrinth: { projectId: mr.projectId, files: mr.files },
        curseforge: cf,
      };
      // The CurseForge jar itself may also be a file Modrinth knows (the
      // author ships identical bytes to both platforms). That alone is one
      // jar tracked two ways; a second, different file is the duplicate.
      const others = mr.files.filter((f) => stripDisabled(f.file) !== stripDisabled(cf.file));
      if (others.length > 0) bothInstalled.push(entry);
      else dualTracked.push(entry);
      continue;
    }
    if (cf) {
      const mrProj = await mrGet<MrProject>(`/project/${encodeURIComponent(slug)}`);
      if (mrProj) {
        availableOnBoth.push({ slug, name: mrProj.title, curseforge: cf, modrinth: { projectId: mrProj.id, files: [] } });
      } else {
        curseforgeOnly.push({ slug, curseforge: cf });
      }
      continue;
    }
    if (mr) {
      // Does CurseForge carry this slug? The search is fuzzy, so only an
      // exact slug match counts. Without a CF API key this check is skipped
      // and the entry is reported as Modrinth-only with cfChecked false.
      let cfProjectId: number | undefined;
      let cfChecked = true;
      try {
        const found = await searchModsCf(cfg, { query: slug, pageSize: 10 });
        cfProjectId = found.find((m) => m.slug === slug)?.id;
      } catch {
        cfChecked = false;
      }
      const entry: CrossModEntry & { cfChecked?: boolean } = {
        slug,
        name: mr.title,
        modrinth: { projectId: mr.projectId, files: mr.files },
      };
      if (cfProjectId !== undefined) {
        entry.curseforge = { projectId: cfProjectId };
        availableOnBoth.push(entry);
      } else {
        if (!cfChecked) entry.cfChecked = false;
        modrinthOnly.push(entry);
      }
    }
  }

  const unknown = jars.filter((j) => !knownFiles.has(j));

  // Side product for the Prism GUI (fork feature): a slug -> both-project-ids
  // table at <dataDir>/prismlauncher-mcp/crossrefs.json lets the launcher's
  // mod search mark a pack as installed when the OTHER source's copy is in
  // the instance. Merged with whatever earlier checks recorded.
  const pairs: Record<string, { modrinth?: string; curseforge?: number }> = {};
  for (const e of [...bothInstalled, ...dualTracked, ...availableOnBoth]) {
    if (e.modrinth?.projectId && e.curseforge?.projectId !== undefined) {
      pairs[e.slug] = { modrinth: e.modrinth.projectId, curseforge: e.curseforge.projectId };
    }
  }
  let crossrefsTotal = 0;
  try {
    const home = path.join(cfg.dataDir, "prismlauncher-mcp");
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, "crossrefs.json");
    let existing: Record<string, { modrinth?: string; curseforge?: number }> = {};
    if (fs.existsSync(file)) {
      existing = (JSON.parse(fs.readFileSync(file, "utf8")) as { pairs?: typeof existing }).pairs ?? {};
    }
    const merged = { ...existing, ...pairs };
    crossrefsTotal = Object.keys(merged).length;
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), pairs: merged }, null, 2),
      "utf8",
    );
  } catch {
    // The table is a convenience for the GUI; never fail the check over it.
  }

  return {
    instance: instanceId,
    bothInstalled,
    dualTracked,
    availableOnBoth,
    curseforgeOnly,
    modrinthOnly,
    unknownJars: unknown,
    crossrefsRecorded: Object.keys(pairs).length,
    crossrefsTotal,
    note: "Matching is by project slug only. bothInstalled = two different files (true duplicates). dualTracked = one file both sources recognize. unknownJars are files neither source could identify (common for mods bundled inside modpacks).",
  };
}

export async function dedupeMod(
  cfg: PrismConfig,
  instanceId: string,
  slug: string,
  keep: "modrinth" | "curseforge",
  confirm?: boolean,
) {
  requireWritable(cfg);
  requireConfirm("dedupe_mod", confirm);
  const report = await crossCheckMods(cfg, instanceId);
  const dup = report.bothInstalled.find((e) => e.slug === slug);
  if (!dup) {
    if (report.dualTracked.some((e) => e.slug === slug)) {
      throw new Error(
        `${slug} is a single file recognized by both sources (dualTracked in cross_check_mods), not a duplicate; there is no second copy to remove`,
      );
    }
    throw new Error(
      `${slug} is not installed from both sources in ${instanceId} (see cross_check_mods); nothing to dedupe`,
    );
  }
  const stripDisabled = (f?: string) => f?.replace(/\.disabled$/, "");
  const removed: unknown[] = [];
  if (keep === "modrinth") {
    if (!dup.curseforge?.file) throw new Error(`the curseforge copy of ${slug} has no file to remove`);
    removed.push(removeMod(cfg, instanceId, dup.curseforge.file, true));
  } else {
    const targets = (dup.modrinth?.files ?? []).filter((f) => stripDisabled(f.file) !== stripDisabled(dup.curseforge?.file));
    if (targets.length === 0) throw new Error(`the modrinth copy of ${slug} has no file to remove`);
    for (const t of targets) removed.push(removeMod(cfg, instanceId, t.file, true));
  }
  return {
    instance: instanceId,
    slug,
    kept: keep,
    keptFiles:
      keep === "modrinth" ? (dup.modrinth?.files ?? []).map((f) => f.file) : [dup.curseforge?.file],
    removed,
  };
}
