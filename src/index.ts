#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import {
  createInstance,
  deleteInstance,
  getInstance,
  listGroups,
  listInstances,
} from "./instances.js";
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

const server = new McpServer({ name: "prism-mcp", version: "0.1.0" });

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`prism-mcp ready (dataDir=${cfg.dataDir}, readOnly=${cfg.readOnly})`);
