#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, migrateStateDir } from "./config.js";
import { bridgeStatus, tryBridge } from "./bridge.js";
import { bootstrapNas } from "./nas.js";
import {
  cloneInstance,
  createInstance,
  deleteInstance,
  exportInstanceZip,
  getInstance,
  getInstanceSetting,
  listGroups,
  listInstances,
  setInstanceSetting,
} from "./instances.js";
import { getSetting, getSettings, setSetting } from "./settings.js";
import { checkModUpdates, listModVersions, removeMod, setModEnabled, updateMod } from "./modrinth.js";
import { getOptions, getWorld, listWorlds, setOption, copyWorld, backupWorld } from "./worlds.js";
import { importModpack, downloadMrpack } from "./modpack.js";
import { buildLangPack, checkLangConsistency, extractLang } from "./lang.js";
import { addServer, listServers, removeServer } from "./servers.js";
import { checkModUpdatesCf, importModpackCf, installModCf, listModFilesCf, loadBlocked, resolveBlockedMods, searchModsCf, updateModCf } from "./curseforge.js";
import { listVersions, LOADER_UIDS } from "./meta.js";
import { installMod, listMods, searchMods } from "./modrinth.js";
import {
  getInstanceStatus,
  getScreenshot,
  launchInstance,
  listScreenshots,
  stopInstance,
  tailLog,
  waitForEvent,
} from "./game.js";

const cfg = loadConfig(process.argv.slice(2));
migrateStateDir(cfg.dataDir);

const server = new McpServer({ name: "prismlauncher-mcp", version: "0.8.0" });

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

// ---- instances ----
server.registerTool(
  "list_instances",
  { description: "List Prism instances in the data dir with Minecraft/loader versions." },
  async () => text(listInstances(cfg)),
);

server.registerTool(
  "get_instance",
  {
    description: "Get one instance's settings (instance.cfg) and component pack (mmc-pack.json).",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => text(getInstance(cfg, id)),
);

server.registerTool(
  "list_versions",
  {
    description:
      "List versions from Prism's meta API. kind: 'minecraft' or a loader alias (forge/fabric/neoforge/quilt/liteloader) or a full meta uid.",
    inputSchema: { kind: z.string(), limit: z.number().optional() },
  },
  async ({ kind, limit }) => {
    const uid = kind === "minecraft" ? "net.minecraft" : (LOADER_UIDS[kind] ?? kind);
    const versions = await listVersions(uid);
    return text(versions.slice(0, limit ?? 50));
  },
);

server.registerTool(
  "create_instance",
  {
    description:
      "Create an instance by writing instance.cfg + mmc-pack.json (Prism resolves the rest on first launch). Loader versions are resolved from the meta API (recommended build for the Minecraft version unless loaderVersion is given).",
    inputSchema: {
      name: z.string(),
      mcVersion: z.string(),
      loader: z.string().optional(),
      loaderVersion: z.string().optional(),
      iconKey: z.string().optional(),
      group: z.string().optional(),
    },
  },
  async (args) => {
    // Prefer the agent bridge when a bridge-enabled Prism is running: the
    // real creation task resolves metadata properly. The bridge requires an
    // explicit loaderVersion, so unresolved cases keep the file-level path.
    const aliasLoaders = ["forge", "neoforge", "fabric", "quilt"];
    const routable =
      (!args.loader || aliasLoaders.includes(args.loader)) && (!args.loader || !!args.loaderVersion);
    if (routable && !cfg.readOnly) {
      const created = await tryBridge<{ taskId: string }>(cfg, "instance.create", {
        name: args.name,
        version: args.mcVersion,
        loader: args.loader,
        loaderVersion: args.loaderVersion,
        icon: args.iconKey,
        group: args.group,
      });
      if (created?.taskId) {
        // Creation runs as a bridge task; poll until it settles.
        const deadline = Date.now() + 180000;
        let state = "working";
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const tasks = await tryBridge<{ id: string; state: string; failReason?: string }[]>(cfg, "task.list", {});
          const mine = tasks?.find((t) => t.id === created.taskId);
          if (!mine) break;
          state = mine.state;
          if (state === "succeeded") {
            try {
              return text({ ...getInstance(cfg, args.name), viaBridge: true, taskId: created.taskId });
            } catch {
              return text({ created: args.name, viaBridge: true, taskId: created.taskId, state });
            }
          }
          if (state === "failed" || state === "aborted") {
            throw new Error(`bridge instance creation ${state}: ${mine.failReason ?? "unknown"}`);
          }
        }
        return text({ created: args.name, viaBridge: true, taskId: created.taskId, state, note: "creation still running in Prism; check list_instances shortly" });
      }
    }
    return text(await createInstance(cfg, args));
  },
);

server.registerTool(
  "delete_instance",
  {
    description: "Delete an instance directory. Destructive: requires confirm: true. Key files are backed up first.",
    inputSchema: { id: z.string(), confirm: z.boolean().optional() },
  },
  async ({ id, confirm }) => text(deleteInstance(cfg, id, confirm)),
);

server.registerTool(
  "list_groups",
  { description: "List instance groups from instgroups.json." },
  async () => text(listGroups(cfg)),
);

server.registerTool(
  "clone_instance",
  {
    description: "Clone an instance directory under a new name (full copy, including worlds).",
    inputSchema: { id: z.string(), newName: z.string() },
  },
  async ({ id, newName }) => text(cloneInstance(cfg, id, newName)),
);

server.registerTool(
  "get_instance_setting",
  {
    description:
      "Read one key from an instance's settings. When a bridge-enabled Prism is running, reports the effective value the app resolves (instance override when its gate is on, otherwise the global value); otherwise reads instance.cfg [General] directly and reports null when the key is absent there.",
    inputSchema: { id: z.string(), key: z.string() },
  },
  async ({ id, key }) => {
    const via = await tryBridge<{ id: string; key: string; value: unknown }>(cfg, "instance.settings.get", { id, key });
    if (via) return text({ id, key, value: via.value, viaBridge: true });
    return text(getInstanceSetting(cfg, id, key));
  },
);

// Prism settings are typed (bool/int/string) while this tool takes strings,
// so coerce the obvious spellings before handing a value to the bridge. The
// file-level write stores the same text in the INI, which Prism parses the
// same way, so both routes agree.
function coerceSettingValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

server.registerTool(
  "set_instance_setting",
  {
    description:
      "Set one key in an instance's settings. When a bridge-enabled Prism is running, the write goes through the app (a file-level write could be overwritten when the app saves on exit) and is verified by reading it back; otherwise instance.cfg is edited directly (backed up and audit-logged). Java and memory tweaks need their Override gate set too, e.g. OverrideJavaArgs=true with JvmArgs, OverrideMemory=true with MinMemAlloc/MaxMemAlloc, OverrideJavaLocation=true with JavaPath.",
    inputSchema: { id: z.string(), key: z.string(), value: z.string() },
  },
  async ({ id, key, value }) => {
    if (!cfg.readOnly) {
      const coerced = coerceSettingValue(value);
      const via = await tryBridge<{ id: string; key: string; value: unknown }>(cfg, "instance.settings.set", { id, key, value: coerced });
      if (via) {
        const check = await tryBridge<{ value: unknown }>(cfg, "instance.settings.get", { id, key });
        if (check && String(check.value ?? "") === String(coerced)) {
          return text({ id, key, value: check.value, viaBridge: true });
        }
        console.error(`[prismlauncher-mcp] bridge instance.settings.set did not stick for ${id}/${key}, falling back to file write`);
      }
    }
    return text(setInstanceSetting(cfg, id, key, value));
  },
);

const INSTANCE_SETTING_KEYS = [
  "name",
  "InstanceType",
  "JavaPath",
  "AutomaticJava",
  "OverrideJavaLocation",
  "JvmArgs",
  "OverrideJavaArgs",
  "MinMemAlloc",
  "MaxMemAlloc",
  "OverrideMemory",
  "LaunchWidth",
  "LaunchHeight",
  "OverrideWindow",
  "ShowConsole",
  "OverrideConsole",
  "JoinServerOnLaunch",
  "JoinServerOnLaunchAddress",
  "JoinWorldOnLaunch",
  "UseAccountForInstance",
];

server.registerTool(
  "list_instance_settings",
  {
    description:
      "Read the common per-instance settings in one call (Java path/args, memory, window, console, join-on-launch, with their Override gates). When a bridge-enabled Prism is running, values are the effective ones the app resolves; otherwise they are read from instance.cfg (absent keys report null).",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const settings: Record<string, unknown> = {};
    const probe = await tryBridge<{ value: unknown }>(cfg, "instance.settings.get", { id, key: INSTANCE_SETTING_KEYS[0] });
    if (probe) {
      settings[INSTANCE_SETTING_KEYS[0]] = probe.value;
      for (const key of INSTANCE_SETTING_KEYS.slice(1)) {
        const r = await tryBridge<{ value: unknown }>(cfg, "instance.settings.get", { id, key });
        settings[key] = r ? r.value : null;
      }
      return text({ id, viaBridge: true, settings });
    }
    for (const key of INSTANCE_SETTING_KEYS) settings[key] = getInstanceSetting(cfg, id, key).value;
    return text({ id, viaBridge: false, settings });
  },
);

server.registerTool(
  "list_javas",
  {
    description:
      "List the Java installations Prism detects on this machine, with probed versions. Requires a running bridge-enabled Prism.",
    inputSchema: {},
  },
  async () => {
    // java.list probes every detected Java on the app's main thread, and a
    // busy app (e.g. rescanning a large instance list) can queue it behind
    // slow work; give it far more than the default 30 s bridge timeout.
    const javas = await tryBridge(cfg, "java.list", {}, 180000);
    if (!javas) throw new Error("no bridge-enabled Prism is running for this data dir; Java detection needs the bridge");
    return text(javas);
  },
);

// Minecraft's Java requirements: 1.20.5+ needs 21, 1.18-1.20.4 needs 17,
// 1.17 needs 16, everything older runs on 8.
function requiredJavaMajor(mcVersion: string): number {
  const [maj = 1, min = 0, patch = 0] = mcVersion.split(".").map(Number);
  if (maj > 1) return 21;
  if (min > 20 || (min === 20 && patch >= 5)) return 21;
  if (min >= 18) return 17;
  if (min === 17) return 16;
  return 8;
}

function javaMajor(version: string | null | undefined): number | null {
  if (!version) return null;
  const p = version.split(".").map(Number);
  if (p[0] === 1) return p[1] ?? null;
  return p[0] ?? null;
}

server.registerTool(
  "diagnose_instance",
  {
    description:
      "Launch-readiness check for an instance: resolves the effective Java (configured path and its probed version), the Java major the instance's Minecraft version requires, and the effective memory settings, then reports concrete issues and warnings. Java probing uses a running bridge-enabled Prism; without one, version checks are skipped and the report says so.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const inst = getInstance(cfg, id);
    const issues: string[] = [];
    const warnings: string[] = [];
    const keys = ["JavaPath", "AutomaticJava", "OverrideJavaLocation", "JvmArgs", "OverrideJavaArgs", "MinMemAlloc", "MaxMemAlloc", "OverrideMemory"];
    const eff: Record<string, unknown> = {};
    let viaBridge = false;
    for (const k of keys) {
      const via = await tryBridge<{ value: unknown }>(cfg, "instance.settings.get", { id, key: k });
      if (via) {
        viaBridge = true;
        eff[k] = via.value;
      } else {
        eff[k] = getInstanceSetting(cfg, id, k).value;
      }
    }
    const javas = (await tryBridge<Array<{ path: string; version: string | null }>>(cfg, "java.list", {}, 180000)) ?? null;
    const required = inst.mcVersion ? requiredJavaMajor(inst.mcVersion) : null;
    const javaPath = String(eff.JavaPath ?? "");
    let javaVersion: string | null = null;
    if (javas) {
      if (javaPath) {
        const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
        const hit = javas.find((j) => norm(j.path) === norm(javaPath));
        if (hit) javaVersion = hit.version;
        else warnings.push(`configured JavaPath is not among the detected installations: ${javaPath}`);
      }
    } else {
      warnings.push("no bridge-enabled Prism is running, so Java versions could not be probed");
    }
    const major = javaMajor(javaVersion);
    if (javaPath && major !== null && required !== null && major < required)
      issues.push(`Java ${javaVersion} is too old: Minecraft ${inst.mcVersion} needs Java ${required}+`);
    if (javaPath && major === null && javas) warnings.push(`could not determine the version of the configured Java: ${javaPath}`);
    const maxMem = Number(eff.MaxMemAlloc ?? 0);
    if (maxMem > 0 && maxMem < 1024) warnings.push(`MaxMemAlloc is ${maxMem} MB; most modded packs need at least 2048 MB`);
    return text({
      id,
      viaBridge,
      minecraft: { version: inst.mcVersion, loader: inst.loader },
      java: {
        path: javaPath || null,
        automatic: eff.AutomaticJava === true || eff.AutomaticJava === "true",
        version: javaVersion,
        requiredMajor: required,
        detected: javas,
      },
      memory: { min: eff.MinMemAlloc, max: eff.MaxMemAlloc, override: eff.OverrideMemory },
      issues,
      warnings,
    });
  },
);

// ---- global settings (prismlauncher.cfg) ----
server.registerTool(
  "get_settings",
  {
    description: "Read global Prism settings (prismlauncher.cfg), one section at a time.",
    inputSchema: { section: z.string().optional() },
  },
  async ({ section }) => text(getSettings(cfg, section ?? "General")),
);

server.registerTool(
  "set_setting",
  {
    description:
      "Set one global Prism setting in prismlauncher.cfg. Backed up and audit-logged; reports requiresPrismRestart when Prism is currently running.",
    inputSchema: { key: z.string(), value: z.string(), section: z.string().optional() },
  },
  async ({ key, value, section }) => {
    // When a bridge-enabled Prism is running, write through the app: a
    // file-level write would be overwritten when the app saves on exit.
    // Prism's settings object only stores registered keys, so verify the
    // write landed; unregistered keys fall back to the file-level write.
    if ((section ?? "General") === "General" && !cfg.readOnly) {
      const via = await tryBridge<{ key: string; value: unknown }>(cfg, "settings.set", { key, value });
      if (via) {
        const check = await tryBridge<{ key: string; value: unknown }>(cfg, "settings.get", { key });
        if (check && String(check.value ?? "") === value) {
          return text({ key, value: check.value, section: "General", viaBridge: true, requiresPrismRestart: false });
        }
        console.error(`[prismlauncher-mcp] bridge settings.set did not stick for ${key} (unregistered key?), falling back to file write`);
      }
    }
    return text(await setSetting(cfg, key, value, section ?? "General"));
  },
);

// ---- mods (Modrinth) ----
server.registerTool(
  "search_mods",
  {
    description: "Search Modrinth. Matches against the instance when mcVersion/loader are omitted only if provided explicitly.",
    inputSchema: {
      query: z.string(),
      loader: z.string().optional(),
      mcVersion: z.string().optional(),
      type: z.enum(["mod", "resourcepack", "shader", "datapack"]).optional(),
      limit: z.number().optional(),
    },
  },
  async (args) => text(await searchMods(args.query, args)),
);

server.registerTool(
  "install_mod",
  {
    description:
      "Install a Modrinth project (id or slug) into an instance, choosing the version that matches the instance's Minecraft version and loader. Required dependencies are installed recursively and reported; optional dependencies are only reported.",
    inputSchema: {
      instance: z.string(),
      project: z.string(),
      type: z.enum(["mod", "resourcepack", "shader", "datapack"]).optional(),
      versionId: z.string().optional(),
    },
  },
  async ({ instance, project, type, versionId }) =>
    text(await installMod(cfg, instance, project, { type, versionId })),
);

server.registerTool(
  "list_mods",
  {
    description: "List jars in an instance's mods folder with enabled state.",
    inputSchema: { instance: z.string() },
  },
  async ({ instance }) => text(listMods(cfg, instance)),
);

server.registerTool(
  "remove_mod",
  {
    description:
      "Remove a mod jar from an instance (its packwiz index entry is removed too). Destructive: requires confirm: true. The jar is backed up first.",
    inputSchema: { instance: z.string(), file: z.string(), confirm: z.boolean().optional() },
  },
  async ({ instance, file, confirm }) => text(removeMod(cfg, instance, file, confirm)),
);

server.registerTool(
  "set_mod_enabled",
  {
    description: "Enable/disable a mod by renaming the jar to/from the .disabled extension Prism uses.",
    inputSchema: { instance: z.string(), file: z.string(), enabled: z.boolean() },
  },
  async ({ instance, file, enabled }) => text(setModEnabled(cfg, instance, file, enabled)),
);

server.registerTool(
  "check_mod_updates",
  {
    description:
      "Check an instance's mod jars against Modrinth by sha1: reports current vs latest matching version per file (files unknown to Modrinth are marked known:false).",
    inputSchema: { instance: z.string() },
  },
  async ({ instance }) => text(await checkModUpdates(cfg, instance)),
);

server.registerTool(
  "update_mod",
  {
    description:
      "Update one mod jar to the latest Modrinth version matching the instance (the old jar is backed up before removal). Fails clearly when the file is unknown to Modrinth.",
    inputSchema: { instance: z.string(), file: z.string() },
  },
  async ({ instance, file }) => text(await updateMod(cfg, instance, file)),
);

server.registerTool(
  "update_all_mods",
  {
    description:
      "Update every mod in an instance that has a newer matching release, across Modrinth-managed and CurseForge-managed mods. Reports what was updated, how many were already current, and what failed. Prerelease-only updates are never applied silently (the same rule as check_mod_updates), and distribution-blocked CurseForge files are reported instead of attempted.",
    inputSchema: { instance: z.string() },
  },
  async ({ instance }) => {
    const updated: unknown[] = [];
    const failed: unknown[] = [];
    let upToDate = 0;
    const report = (await checkModUpdates(cfg, instance)) as Array<Record<string, unknown>>;
    for (const entry of report) {
      if (!entry.known) continue;
      if (!entry.updateAvailable) {
        upToDate++;
        continue;
      }
      try {
        updated.push(await updateMod(cfg, instance, String(entry.file)));
      } catch (e) {
        failed.push({ file: entry.file, error: e instanceof Error ? e.message : String(e) });
      }
    }
    try {
      const cf = (await checkModUpdatesCf(cfg, instance)) as {
        upToDate: number;
        updates: Array<Record<string, unknown>>;
      };
      upToDate += cf.upToDate;
      for (const u of cf.updates) {
        if (u.problem) {
          failed.push({ slug: u.slug, error: String(u.problem) });
          continue;
        }
        if (u.blocked) {
          failed.push({ slug: u.slug, error: "latest CurseForge file is distribution-blocked" });
          continue;
        }
        try {
          updated.push(await updateModCf(cfg, instance, String(u.slug ?? u.projectId)));
        } catch (e) {
          failed.push({ slug: u.slug, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch {
      // No CurseForge-managed mods (or no API key): the Modrinth side stands.
    }
    return text({ instance, updated, upToDate, failed });
  },
);

// ---- worlds & options ----
server.registerTool(
  "list_worlds",
  {
    description: "List single-player worlds (saves/) with level.dat info: name, version, game mode, seed, last played.",
    inputSchema: { instance: z.string() },
  },
  async ({ instance }) => text(await listWorlds(cfg, instance)),
);

server.registerTool(
  "get_world",
  {
    description: "Get one world's level.dat info by folder name.",
    inputSchema: { instance: z.string(), world: z.string() },
  },
  async ({ instance, world }) => text(await getWorld(cfg, instance, world)),
);

server.registerTool(
  "copy_world",
  {
    description: "Copy a world folder inside an instance under a new name (the copy's session.lock is dropped).",
    inputSchema: { instance: z.string(), world: z.string(), newName: z.string() },
  },
  async ({ instance, world, newName }) => text(copyWorld(cfg, instance, world, newName)),
);

server.registerTool(
  "backup_world",
  {
    description:
      "Zip a world folder into the server's backups/worlds directory (under the data dir's prismlauncher-mcp folder) and return the backup path.",
    inputSchema: { instance: z.string(), world: z.string() },
  },
  async ({ instance, world }) => text(backupWorld(cfg, instance, world)),
);

server.registerTool(
  "get_options",
  {
    description: "Read the instance's minecraft/options.txt as key:value pairs.",
    inputSchema: { instance: z.string() },
  },
  async ({ instance }) => text(getOptions(cfg, instance)),
);

server.registerTool(
  "set_option",
  {
    description: "Set one key in the instance's options.txt. Backed up and audit-logged.",
    inputSchema: { instance: z.string(), key: z.string(), value: z.string() },
  },
  async ({ instance, key, value }) => text(setOption(cfg, instance, key, value)),
);

// ---- modpacks ----
server.registerTool(
  "import_modpack",
  {
    description:
      "Import a Modrinth .mrpack file: creates the instance from the pack's declared Minecraft/loader versions, downloads every client file with sha1 verification, and extracts overrides.",
    inputSchema: { path: z.string(), name: z.string().optional() },
  },
  async ({ path: p, name }) => text(await importModpack(cfg, p, name)),
);

server.registerTool(
  "install_modpack",
  {
    description:
      "Install a Modrinth modpack by project id or slug. When a bridge-enabled Prism is running, the app installs the pack itself and registers it as a managed pack (so Prism can check it for updates later). Otherwise the .mrpack is downloaded and imported at the file level. Packs whose client files include optional mods are refused by the bridge in headless mode (they need a dialog); the file-level fallback handles those.",
    inputSchema: { project: z.string(), versionId: z.string().optional(), name: z.string().optional() },
  },
  async ({ project, versionId, name }) => {
    if (!cfg.readOnly) {
      const created = await tryBridge<{ taskId: string }>(cfg, "pack.create", { projectId: project, versionId, name });
      if (created?.taskId) {
        const deadline = Date.now() + 600000;
        let state = "working";
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const tasks = await tryBridge<{ id: string; state: string; failReason?: string }[]>(cfg, "task.list", {});
          const mine = tasks?.find((t) => t.id === created.taskId);
          if (!mine) break;
          state = mine.state;
          if (state === "succeeded") {
            if (name) {
              try {
                return text({ ...getInstance(cfg, name), viaBridge: true, taskId: created.taskId });
              } catch {
                /* fall through to the generic report */
              }
            }
            return text({ installed: project, viaBridge: true, taskId: created.taskId, state });
          }
          if (state === "failed" || state === "aborted") {
            throw new Error(`bridge pack install ${state}: ${mine.failReason ?? "unknown"}`);
          }
        }
        return text({ installed: project, viaBridge: true, taskId: created.taskId, state, note: "install still running in Prism; check list_instances shortly" });
      }
    }
    const dl = await downloadMrpack(cfg, project, versionId);
    const result = await importModpack(cfg, dl.file, name);
    return text({ ...result, downloadedVersion: dl.versionNumber });
  },
);

server.registerTool(
  "export_instance",
  {
    description:
      "Export an instance as a Modrinth .mrpack (default) or a plain zip, into the data dir's prismlauncher-mcp/exports folder unless output is given. The mrpack format requires a running bridge-enabled Prism (the app resolves mod files against Modrinth); the zip format falls back to a file-level archive when no bridge is up. Logs, crash reports and backups are excluded either way.",
    inputSchema: {
      id: z.string(),
      format: z.enum(["mrpack", "zip"]).optional(),
      name: z.string().optional(),
      version: z.string().optional(),
      output: z.string().optional(),
    },
  },
  async ({ id, format, name, version, output }) => {
    const fmt = format ?? "mrpack";
    if (!cfg.readOnly) {
      const started = await tryBridge<{ taskId: string; output: string; format: string }>(cfg, "instance.export", {
        id,
        format: fmt,
        name,
        version,
        output,
      });
      if (started?.taskId) {
        const deadline = Date.now() + 600000;
        let state = "working";
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const tasks = await tryBridge<{ id: string; state: string; failReason?: string }[]>(cfg, "task.list", {});
          const mine = tasks?.find((t) => t.id === started.taskId);
          if (!mine) break;
          state = mine.state;
          if (state === "succeeded") return text({ id, ...started, viaBridge: true, state });
          if (state === "failed" || state === "aborted")
            throw new Error(`bridge export ${state}: ${mine.failReason ?? "unknown"}`);
        }
        return text({ id, ...started, viaBridge: true, state, note: "export still running in Prism; the file appears at the output path when it finishes" });
      }
    }
    if (fmt === "zip") return text(exportInstanceZip(cfg, id, output));
    throw new Error("mrpack export needs a running bridge-enabled Prism for this data dir");
  },
);

// ---- agent bridge (Phase 2) ----
server.registerTool(
  "bridge_status",
  {
    description:
      "Check whether a bridge-enabled Prism (GUI or PrismLauncher-Agent headless) is running for this data dir. When available, launch/stop/create/set_setting/instance settings route through the live app.",
  },
  async () => text(await bridgeStatus(cfg)),
);

// ---- game ----
server.registerTool(
  "launch_instance",
  {
    description: "Launch an instance through Prism (--launch). Prism/game start asynchronously.",
    inputSchema: {
      id: z.string(),
      world: z.string().optional(),
      server: z.string().optional(),
      profile: z.string().optional(),
      offline: z.string().optional(),
    },
  },
  async ({ id, ...opts }) => {
    // Route launches through a running bridge-enabled Prism so the game is
    // owned by that process instead of spawning a second launcher. The
    // bridge launch accepts server/world targets; profile and offline
    // launches keep the CLI route, whose semantics differ slightly.
    if (!opts.profile && !opts.offline && !cfg.readOnly) {
      const via = await tryBridge(cfg, "launch", { id, server: opts.server, world: opts.world });
      if (via) return text({ launched: id, viaBridge: true, bridge: via, note: "launched by the running Prism; poll get_instance_status / wait_for_event" });
    }
    return text(launchInstance(cfg, id, opts));
  },
);

server.registerTool(
  "get_instance_status",
  {
    description: "Running state (javaw command-line match), log presence and last log lines.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => text(await getInstanceStatus(cfg, id)),
);

server.registerTool(
  "tail_log",
  {
    description: "Return the last lines of the instance's minecraft/logs/latest.log.",
    inputSchema: { id: z.string(), lines: z.number().optional() },
  },
  async ({ id, lines }) => text(tailLog(cfg, id, lines ?? 100)),
);

server.registerTool(
  "wait_for_event",
  {
    description: "Wait until a regex matches a new line in latest.log (e.g. 'Setting user|Backend library|Stopping!'), or timeout.",
    inputSchema: { id: z.string(), pattern: z.string(), timeoutMs: z.number().optional() },
  },
  async ({ id, pattern, timeoutMs }) => text(await waitForEvent(cfg, id, pattern, timeoutMs)),
);

server.registerTool(
  "stop_instance",
  {
    description:
      "Kill the javaw process whose command line matches this instance exactly. Destructive: requires confirm: true.",
    inputSchema: { id: z.string(), confirm: z.boolean().optional() },
  },
  async ({ id, confirm }) => {
    if (confirm === true && !cfg.readOnly) {
      const via = await tryBridge<{ id: string; stopped: boolean }>(cfg, "launch.stop", { id });
      if (via) return text({ ...via, viaBridge: true });
    }
    return text(await stopInstance(cfg, id, confirm));
  },
);

server.registerTool(
  "list_screenshots",
  {
    description: "List screenshots in the instance's minecraft/screenshots folder.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => text(listScreenshots(cfg, id)),
);

server.registerTool(
  "get_screenshot",
  {
    description: "Fetch one screenshot as an image (visual launch verification).",
    inputSchema: { id: z.string(), file: z.string() },
  },
  async ({ id, file }) => {
    const shot = getScreenshot(cfg, id, file);
    return {
      content: [
        { type: "image" as const, data: shot.base64, mimeType: shot.mimeType },
      ],
    };
  },
);


// ---- multiplayer servers (servers.dat) ----
server.registerTool(
  "list_servers",
  { description: "List the multiplayer servers saved in the instance's servers.dat.", inputSchema: { instanceId: z.string() } },
  async ({ instanceId }) => text(await listServers(cfg, instanceId)),
);

server.registerTool(
  "add_server",
  {
    description: "Add a multiplayer server to the instance's servers.dat (created if missing). The previous file is backed up.",
    inputSchema: { instanceId: z.string(), name: z.string(), ip: z.string() },
  },
  async ({ instanceId, name, ip }) => text(await addServer(cfg, instanceId, name, ip)),
);

server.registerTool(
  "remove_server",
  {
    description: "Remove multiplayer server entries matching a name or ip from servers.dat. Destructive: needs confirm: true.",
    inputSchema: { instanceId: z.string(), name: z.string().optional(), ip: z.string().optional(), confirm: z.boolean().optional() },
  },
  async ({ instanceId, name, ip, confirm }) => text(await removeServer(cfg, instanceId, { name, ip }, confirm)),
);

// ---- translation support (explicit invocation only; never automatic) ----
server.registerTool(
  "extract_lang",
  {
    description:
      "Extract a mod jar's language files (assets/<modid>/lang/*) into prismlauncher-mcp/lang-work/<slug>/source for translation. Explicit use only.",
    inputSchema: { instanceId: z.string().optional(), modFile: z.string().optional(), jarPath: z.string().optional() },
  },
  async (args) => text(extractLang(cfg, args)),
);

server.registerTool(
  "check_lang_consistency",
  {
    description:
      "Compare translated lang files against the extracted source: missing/extra keys, placeholder and format-code mismatches, untranslated leftovers. Read-only.",
    inputSchema: { slug: z.string(), sourceLocale: z.string().optional(), targetLocale: z.string().optional() },
  },
  async (args) => text(checkLangConsistency(cfg, args)),
);

server.registerTool(
  "build_lang_pack",
  {
    description:
      "Build a resource pack zip from prismlauncher-mcp/lang-work/<slug>/translated and install it into an instance's resourcepacks. Overwriting an existing pack needs confirm: true.",
    inputSchema: {
      slug: z.string(),
      instanceId: z.string(),
      packName: z.string().optional(),
      description: z.string().optional(),
      confirm: z.boolean().optional(),
    },
  },
  async (args) => text(buildLangPack(cfg, args)),
);


server.registerTool(
  "list_mod_versions",
  {
    description:
      "List a Modrinth project's versions (newest first). With instanceId, versions are annotated with matchesInstance and the auto-picked latest release is shown. Use a version's id with install_mod to pin or roll back a version.",
    inputSchema: { project: z.string(), instanceId: z.string().optional() },
  },
  async ({ project, instanceId }) => text(await listModVersions(cfg, project, instanceId)),
);

// ---- CurseForge ----
server.registerTool(
  "search_mods_cf",
  {
    description: "Search CurseForge for Minecraft mods (uses the user's own API key from Prism's FlameKeyOverride setting).",
    inputSchema: {
      query: z.string(),
      gameVersion: z.string().optional(),
      loader: z.string().optional(),
      pageSize: z.number().optional(),
    },
  },
  async (args) => text(await searchModsCf(cfg, args)),
);

server.registerTool(
  "list_mod_files_cf",
  {
    description:
      "List a CurseForge mod's files. With instanceId, files are filtered to the instance's MC version/loader and the auto-picked latest release is shown. Use a file's fileId with install_mod_cf to pin or roll back a version.",
    inputSchema: { modId: z.number(), instanceId: z.string().optional() },
  },
  async (args) => text(await listModFilesCf(cfg, args)),
);

server.registerTool(
  "install_mod_cf",
  {
    description:
      "Install a mod from CurseForge into an instance (latest release matching the instance's MC version/loader unless fileId is given; required dependencies are installed recursively). If the author disabled third-party distribution, the file comes back in `blocked` with its mod-page URL: ask the user to download it manually, then call resolve_blocked_mods. Never scrape CurseForge pages or use unofficial mirrors.",
    inputSchema: { instanceId: z.string(), modId: z.number(), fileId: z.number().optional() },
  },
  async ({ instanceId, ...args }) => text(await installModCf(cfg, instanceId, args)),
);

server.registerTool(
  "list_blocked_mods",
  {
    description: "List CurseForge files for an instance that are waiting for the user to download them manually.",
    inputSchema: { instanceId: z.string() },
  },
  async ({ instanceId }) => text(loadBlocked(cfg, instanceId)),
);

server.registerTool(
  "check_mod_updates_cf",
  {
    description:
      "Check CurseForge-installed mods (those with a [update.curseforge] index entry) for a newer release matching the instance. Read-only.",
    inputSchema: { instanceId: z.string() },
  },
  async ({ instanceId }) => text(await checkModUpdatesCf(cfg, instanceId)),
);

server.registerTool(
  "update_mod_cf",
  {
    description:
      "Update one CurseForge-installed mod (by index slug or project id) to the latest release matching the instance; the old jar is backed up and removed.",
    inputSchema: { instanceId: z.string(), mod: z.string() },
  },
  async ({ instanceId, mod }) => text(await updateModCf(cfg, instanceId, mod)),
);

server.registerTool(
  "import_modpack_cf",
  {
    description:
      "Import a CurseForge modpack zip (manifest.json format): creates the instance from the pack's Minecraft/loader declaration, installs every required file (blocked files are reported and recorded for manual download, per the blocked policy), and extracts overrides. Optional (required: false) files are reported, not installed.",
    inputSchema: { zipPath: z.string(), name: z.string().optional() },
  },
  async ({ zipPath, name }) => text(await importModpackCf(cfg, zipPath, name)),
);

server.registerTool(
  "resolve_blocked_mods",
  {
    description:
      "Scan a folder for user-downloaded jars, sha1-match them against the instance's pending blocked CurseForge files, and place matches into the instance's mods folder.",
    inputSchema: { instanceId: z.string(), folder: z.string() },
  },
  async ({ instanceId, folder }) => text(await resolveBlockedMods(cfg, instanceId, folder)),
);

await bootstrapNas();

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`prismlauncher-mcp ready (dataDir=${cfg.dataDir}, readOnly=${cfg.readOnly})`);
