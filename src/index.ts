#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { bootstrapNas } from "./nas.js";
import {
  cloneInstance,
  createInstance,
  deleteInstance,
  getInstance,
  listGroups,
  listInstances,
  setInstanceSetting,
} from "./instances.js";
import { getSetting, getSettings, setSetting } from "./settings.js";
import { checkModUpdates, listModVersions, removeMod, setModEnabled, updateMod } from "./modrinth.js";
import { getOptions, getWorld, listWorlds, setOption } from "./worlds.js";
import { importModpack } from "./modpack.js";
import { buildLangPack, checkLangConsistency, extractLang } from "./lang.js";
import { installModCf, listModFilesCf, loadBlocked, resolveBlockedMods, searchModsCf } from "./curseforge.js";
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

const server = new McpServer({ name: "prism-mcp", version: "0.3.1" });

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
  async (args) => text(await createInstance(cfg, args)),
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
  "set_instance_setting",
  {
    description: "Set one key in an instance's instance.cfg [General] section. Backed up and audit-logged.",
    inputSchema: { id: z.string(), key: z.string(), value: z.string() },
  },
  async ({ id, key, value }) => text(setInstanceSetting(cfg, id, key, value)),
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
  async ({ key, value, section }) => text(await setSetting(cfg, key, value, section ?? "General")),
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
  async ({ id, ...opts }) => text(launchInstance(cfg, id, opts)),
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
  async ({ id, confirm }) => text(await stopInstance(cfg, id, confirm)),
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


// ---- translation support (explicit invocation only; never automatic) ----
server.registerTool(
  "extract_lang",
  {
    description:
      "Extract a mod jar's language files (assets/<modid>/lang/*) into prism-mcp/lang-work/<slug>/source for translation. Explicit use only.",
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
      "Build a resource pack zip from prism-mcp/lang-work/<slug>/translated and install it into an instance's resourcepacks. Overwriting an existing pack needs confirm: true.",
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
console.error(`prism-mcp ready (dataDir=${cfg.dataDir}, readOnly=${cfg.readOnly})`);
