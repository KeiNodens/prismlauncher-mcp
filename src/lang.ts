import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { instanceDir, mcpHome, type PrismConfig } from "./config.js";
import { audit, backupFiles, requireConfirm, requireWritable } from "./safety.js";

// Translation support tools (user decision 2026-10-31): these are part of
// prism-mcp but are NEVER triggered automatically by other tools. They only
// run when a client explicitly calls them.
//
// Workflow:
//   1. extract_lang            jar -> <mcpHome>/lang-work/<slug>/source/...
//   2. (a human or an LLM translates the files under source/ into
//      translated/, keeping the same relative paths and locale file names)
//   3. check_lang_consistency  key coverage + placeholder/format-code diff
//   4. build_lang_pack         translated/ -> resource pack zip installed
//      into the target instance's resourcepacks/

const LANG_ENTRY = /^assets\/([^/]+)\/lang\/([^/]+)\.(json|lang)$/;

export function langWorkRoot(cfg: PrismConfig): string {
  return path.join(mcpHome(cfg.dataDir), "lang-work");
}

function slugify(name: string): string {
  return name
    .replace(/\.jar$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseLangJson(text: string): Record<string, string> {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function parseLangProps(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

export interface ExtractedFile {
  entry: string; // assets/<domain>/lang/<locale>.<ext> inside the jar
  domain: string;
  locale: string;
  format: "json" | "lang";
  keys: number;
  writtenTo: string; // path relative to the work dir
}

export function extractLang(
  cfg: PrismConfig,
  args: { instanceId?: string; modFile?: string; jarPath?: string },
) {
  requireWritable(cfg);
  let jar: string;
  if (args.jarPath) {
    jar = args.jarPath;
  } else if (args.instanceId && args.modFile) {
    jar = path.join(instanceDir(cfg.dataDir, args.instanceId), "minecraft", "mods", args.modFile);
  } else {
    throw new Error("extract_lang needs either jarPath or instanceId + modFile");
  }
  if (!fs.existsSync(jar)) throw new Error(`jar not found: ${jar}`);

  const slug = slugify(path.basename(jar));
  const workDir = path.join(langWorkRoot(cfg), slug);
  const sourceDir = path.join(workDir, "source");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, "translated"), { recursive: true });

  const zip = new AdmZip(jar);
  const files: ExtractedFile[] = [];
  for (const entry of zip.getEntries()) {
    const m = LANG_ENTRY.exec(entry.entryName);
    if (!m || entry.isDirectory) continue;
    const [, domain, locale, ext] = m;
    const text = entry.getData().toString("utf8");
    let keys = 0;
    try {
      keys =
        ext === "json"
          ? Object.keys(parseLangJson(text)).length
          : Object.keys(parseLangProps(text)).length;
    } catch {
      keys = -1; // unparsable file; still extracted for manual inspection
    }
    const dest = path.join(sourceDir, ...entry.entryName.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, "utf8");
    files.push({
      entry: entry.entryName,
      domain,
      locale,
      format: ext as "json" | "lang",
      keys,
      writtenTo: path.relative(workDir, dest),
    });
  }
  const manifest = { slug, jar, extractedAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(workDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  audit(cfg, "extract_lang", jar, { slug, fileCount: files.length });
  return {
    slug,
    workDir,
    fileCount: files.length,
    totalKeys: files.reduce((a, f) => a + Math.max(0, f.keys), 0),
    files,
    nextStep:
      "Translate the files under source/ into translated/ (same relative paths, target-locale file names), then run check_lang_consistency and build_lang_pack.",
  };
}

// ---- consistency check (pure core, unit-tested) ----

export function placeholdersOf(value: string): string[] {
  const found: string[] = [];
  const re = /%(\d+\$)?[a-zA-Z%]|§.|{\d+}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) found.push(m[0]);
  return found.sort();
}

export interface LangDiff {
  missing: string[];
  extra: string[];
  placeholderMismatch: { key: string; source: string[]; translated: string[] }[];
  identicalValues: string[];
}

export function compareLang(
  source: Record<string, string>,
  translated: Record<string, string>,
): LangDiff {
  const missing: string[] = [];
  const placeholderMismatch: LangDiff["placeholderMismatch"] = [];
  const identicalValues: string[] = [];
  for (const [key, srcVal] of Object.entries(source)) {
    const tr = translated[key];
    if (tr === undefined) {
      missing.push(key);
      continue;
    }
    const a = placeholdersOf(srcVal);
    const b = placeholdersOf(tr);
    if (a.join("") !== b.join("")) placeholderMismatch.push({ key, source: a, translated: b });
    if (tr === srcVal && srcVal.length > 0) identicalValues.push(key);
  }
  const extra = Object.keys(translated).filter((k) => !(k in source));
  return { missing, extra, placeholderMismatch, identicalValues };
}

function loadLangFile(p: string): Record<string, string> {
  const text = fs.readFileSync(p, "utf8");
  return p.endsWith(".json") ? parseLangJson(text) : parseLangProps(text);
}

export function checkLangConsistency(
  cfg: PrismConfig,
  args: { slug: string; sourceLocale?: string; targetLocale?: string },
) {
  const sourceLocale = args.sourceLocale ?? "en_us";
  const targetLocale = args.targetLocale ?? "ja_jp";
  const workDir = path.join(langWorkRoot(cfg), args.slug);
  const sourceRoot = path.join(workDir, "source");
  if (!fs.existsSync(sourceRoot)) throw new Error(`no extracted source for slug: ${args.slug}`);

  const reports: unknown[] = [];
  const totals = { files: 0, sourceKeys: 0, missing: 0, extra: 0, placeholderMismatch: 0, identical: 0 };
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name === `${sourceLocale}.json` || name === `${sourceLocale}.lang`) {
        const rel = path.relative(sourceRoot, p);
        const targetRel = rel.replace(`${sourceLocale}.`, `${targetLocale}.`);
        const targetPath = path.join(workDir, "translated", targetRel);
        const source = loadLangFile(p);
        totals.files += 1;
        totals.sourceKeys += Object.keys(source).length;
        if (!fs.existsSync(targetPath)) {
          reports.push({ file: rel, status: "no_translation_file", sourceKeys: Object.keys(source).length });
          totals.missing += Object.keys(source).length;
          continue;
        }
        const diff = compareLang(source, loadLangFile(targetPath));
        totals.missing += diff.missing.length;
        totals.extra += diff.extra.length;
        totals.placeholderMismatch += diff.placeholderMismatch.length;
        totals.identical += diff.identicalValues.length;
        reports.push({
          file: rel,
          translatedFile: targetRel,
          sourceKeys: Object.keys(source).length,
          missing: diff.missing.length,
          missingSample: diff.missing.slice(0, 10),
          extra: diff.extra,
          placeholderMismatch: diff.placeholderMismatch,
          identicalValues: diff.identicalValues.length,
          identicalSample: diff.identicalValues.slice(0, 10),
        });
      }
    }
  };
  walk(sourceRoot);
  return { slug: args.slug, sourceLocale, targetLocale, totals, reports };
}

// ---- resource pack build ----

export function buildLangPack(
  cfg: PrismConfig,
  args: { slug: string; instanceId: string; packName?: string; description?: string; confirm?: boolean },
) {
  requireWritable(cfg);
  const workDir = path.join(langWorkRoot(cfg), args.slug);
  const translatedRoot = path.join(workDir, "translated");
  if (!fs.existsSync(translatedRoot)) throw new Error(`no translated/ dir for slug: ${args.slug}`);

  const entries: { rel: string; full: string }[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else entries.push({ rel: path.relative(translatedRoot, p).split(path.sep).join("/"), full: p });
    }
  };
  walk(translatedRoot);
  const langEntries = entries.filter((e) => LANG_ENTRY.test(e.rel));
  if (langEntries.length === 0) {
    throw new Error("translated/ contains no assets/<modid>/lang/* files; nothing to pack");
  }

  const packName = args.packName ?? `${args.slug}-lang-ja`;
  const zip = new AdmZip();
  zip.addFile(
    "pack.mcmeta",
    Buffer.from(
      JSON.stringify(
        { pack: { pack_format: 15, description: args.description ?? `${packName} (built by prism-mcp)` } },
        null,
        2,
      ),
      "utf8",
    ),
  );
  for (const e of langEntries) zip.addFile(e.rel, fs.readFileSync(e.full));

  const rpDir = path.join(instanceDir(cfg.dataDir, args.instanceId), "minecraft", "resourcepacks");
  fs.mkdirSync(rpDir, { recursive: true });
  const dest = path.join(rpDir, `${packName}.zip`);
  let backupDir: string | undefined;
  if (fs.existsSync(dest)) {
    requireConfirm("build_lang_pack (overwrites an existing pack)", args.confirm);
    backupDir = backupFiles(cfg, [dest]);
  }
  zip.writeZip(dest);
  audit(cfg, "build_lang_pack", dest, { slug: args.slug, files: langEntries.map((e) => e.rel) });
  return {
    pack: dest,
    files: langEntries.map((e) => e.rel),
    ...(backupDir ? { backupDir } : {}),
    note: "Enable the pack in the game's resource pack screen (or via options.txt resourcePacks).",
  };
}
