import AdmZip from "adm-zip";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { instanceDir, type PrismConfig } from "./config.js";
import { createInstance } from "./instances.js";
import { audit, requireWritable } from "./safety.js";

// .mrpack (Modrinth pack) import, file-level:
// - read modrinth.index.json from the zip
// - create the instance from its dependencies (minecraft + loader)
// - download each listed file (sha1-verified), skipping server-only files
// - extract overrides/ and client-overrides/ into the instance's minecraft/

interface MrpackIndex {
  formatVersion: number;
  game: string;
  name: string;
  versionId?: string;
  summary?: string;
  dependencies: Record<string, string>;
  files: Array<{
    path: string;
    hashes: { sha1: string; sha512?: string };
    downloads: string[];
    env?: { client?: string; server?: string };
    fileSize?: number;
  }>;
}

const DEP_TO_LOADER: Record<string, string> = {
  forge: "forge",
  "fabric-loader": "fabric",
  "quilt-loader": "quilt",
  neoforge: "neoforge",
};

function sha1(buf: Buffer): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

export async function importModpack(cfg: PrismConfig, mrpackPath: string, nameOverride?: string) {
  requireWritable(cfg);
  if (!fs.existsSync(mrpackPath)) throw new Error(`mrpack not found: ${mrpackPath}`);
  const zip = new AdmZip(mrpackPath);
  const indexEntry = zip.getEntry("modrinth.index.json");
  if (!indexEntry) throw new Error("modrinth.index.json missing — not an .mrpack file");
  const index = JSON.parse(indexEntry.getData().toString("utf8")) as MrpackIndex;
  if (index.game !== "minecraft") throw new Error(`unsupported pack game: ${index.game}`);

  const mcVersion = index.dependencies["minecraft"];
  if (!mcVersion) throw new Error("pack index has no minecraft dependency");
  const loaderKey = Object.keys(DEP_TO_LOADER).find((k) => index.dependencies[k]);
  const name = nameOverride ?? index.name;

  const created = await createInstance(cfg, {
    name,
    mcVersion,
    loader: loaderKey ? DEP_TO_LOADER[loaderKey] : undefined,
    loaderVersion: loaderKey ? index.dependencies[loaderKey] : undefined,
  });
  const mcDir = path.join(instanceDir(cfg.dataDir, created.id), "minecraft");
  fs.mkdirSync(mcDir, { recursive: true });

  let downloaded = 0;
  let skippedServerOnly = 0;
  const failures: string[] = [];
  for (const file of index.files) {
    if (file.env?.client === "unsupported") {
      skippedServerOnly++;
      continue;
    }
    const dest = path.join(mcDir, ...file.path.split("/"));
    let ok = false;
    for (const url of file.downloads) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "prismlauncher-mcp/0.1.0" } });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (sha1(buf) !== file.hashes.sha1) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        ok = true;
        break;
      } catch {
        // try next mirror
      }
    }
    if (ok) downloaded++;
    else failures.push(file.path);
  }

  let overrides = 0;
  for (const entry of zip.getEntries()) {
    const m = entry.entryName.match(/^(client-)?overrides\/(.+)$/);
    if (!m || entry.isDirectory) continue;
    const dest = path.join(mcDir, ...m[2].split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    overrides++;
  }

  audit(cfg, "import_modpack", created.id, { mrpackPath, downloaded, failures: failures.length });
  return {
    instance: created.id,
    packName: index.name,
    packVersion: index.versionId,
    mcVersion,
    loader: loaderKey,
    downloaded,
    skippedServerOnly,
    overrides,
    failures,
  };
}

// Download a Modrinth pack's .mrpack by project, for the no-bridge fallback
// of install_modpack. Picks the requested version, else the newest release
// (then beta/alpha), and within it the primary .mrpack file.
const MR_API = "https://api.modrinth.com/v2";
const MR_UA = "prismlauncher-mcp/0.1.0 (https://github.com/PrismLauncher)";

interface MrPackVersion {
  id: string;
  version_number: string;
  version_type: string;
  files: { filename: string; url: string; primary: boolean }[];
}

export async function downloadMrpack(cfg: PrismConfig, projectId: string, versionId?: string): Promise<{ file: string; versionNumber: string }> {
  const res = await fetch(`${MR_API}/project/${encodeURIComponent(projectId)}/version`, { headers: { "User-Agent": MR_UA } });
  if (!res.ok) throw new Error(`Modrinth versions -> HTTP ${res.status}`);
  const versions = (await res.json()) as MrPackVersion[];
  const packVersions = versions.filter((v) => v.files.some((f) => f.filename.endsWith(".mrpack")));
  if (packVersions.length === 0) throw new Error(`project ${projectId} has no .mrpack versions`);
  const picked = versionId
    ? packVersions.find((v) => v.id === versionId)
    : (packVersions.find((v) => v.version_type === "release") ?? packVersions[0]);
  if (!picked) throw new Error(`pack version not found: ${versionId}`);
  const file = picked.files.find((f) => f.primary && f.filename.endsWith(".mrpack")) ?? picked.files.find((f) => f.filename.endsWith(".mrpack"))!;
  const { mcpHome } = await import("./config.js");
  const dir = path.join(mcpHome(cfg.dataDir), "downloads");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file.filename);
  const dl = await fetch(file.url, { headers: { "User-Agent": MR_UA } });
  if (!dl.ok) throw new Error(`mrpack download -> HTTP ${dl.status}`);
  fs.writeFileSync(dest, Buffer.from(await dl.arrayBuffer()));
  return { file: dest, versionNumber: picked.version_number };
}
