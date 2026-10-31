import fs from "node:fs";
import path from "node:path";
import nbt from "prismarine-nbt";
import { instanceDir, type PrismConfig } from "./config.js";
import { audit, backupFiles, requireConfirm, requireWritable } from "./safety.js";

// Multiplayer server list (minecraft/servers.dat, uncompressed NBT):
// root compound { servers: [ { name: string, ip: string, icon?: string,
// acceptTextures?: byte } ] }. Edits manipulate the typed NBT tree so
// unknown fields on existing entries survive untouched.

type Tree = any;

function serversDatPath(cfg: PrismConfig, instanceId: string): string {
  return path.join(instanceDir(cfg.dataDir, instanceId), "minecraft", "servers.dat");
}

function emptyTree(): Tree {
  return {
    type: "compound",
    name: "",
    value: { servers: { type: "list", value: { type: "compound", value: [] } } },
  };
}

async function readTree(cfg: PrismConfig, instanceId: string): Promise<Tree> {
  const p = serversDatPath(cfg, instanceId);
  if (!fs.existsSync(p)) return emptyTree();
  const { parsed } = await nbt.parse(fs.readFileSync(p));
  return parsed as Tree;
}

function serverEntries(tree: Tree): Tree[] {
  const list = tree?.value?.servers;
  if (!list || list.type !== "list") return [];
  return (list.value?.value ?? []) as Tree[];
}

export function serversFromTree(tree: Tree): { name: string; ip: string }[] {
  return serverEntries(tree).map((e) => ({
    name: String(e?.name?.value ?? ""),
    ip: String(e?.ip?.value ?? ""),
  }));
}

export function addToTree(tree: Tree, name: string, ip: string): Tree {
  if (!tree.value.servers) {
    tree.value.servers = { type: "list", value: { type: "compound", value: [] } };
  }
  const list = tree.value.servers;
  if (!Array.isArray(list.value.value)) list.value = { type: "compound", value: [] };
  list.value.value.push({
    name: { type: "string", value: name },
    ip: { type: "string", value: ip },
  });
  return tree;
}

export function removeFromTree(tree: Tree, match: { name?: string; ip?: string }): number {
  const entries = serverEntries(tree);
  const kept = entries.filter((e) => {
    const nameHit = match.name !== undefined && e?.name?.value === match.name;
    const ipHit = match.ip !== undefined && e?.ip?.value === match.ip;
    return !(nameHit || ipHit);
  });
  const removed = entries.length - kept.length;
  if (tree?.value?.servers?.value) tree.value.servers.value.value = kept;
  return removed;
}

async function writeTree(cfg: PrismConfig, instanceId: string, tree: Tree): Promise<void> {
  const p = serversDatPath(cfg, instanceId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) backupFiles(cfg, [p]);
  const out = (nbt as any).writeUncompressed(tree, "big");
  const buf: Buffer = Buffer.isBuffer(out) ? out : await out;
  fs.writeFileSync(p, buf);
}

export async function listServers(cfg: PrismConfig, instanceId: string) {
  const tree = await readTree(cfg, instanceId);
  return { instance: instanceId, servers: serversFromTree(tree) };
}

export async function addServer(cfg: PrismConfig, instanceId: string, name: string, ip: string) {
  requireWritable(cfg);
  const tree = await readTree(cfg, instanceId);
  if (serversFromTree(tree).some((s) => s.ip === ip && s.name === name)) {
    return { added: false, reason: "an entry with this name and ip already exists", servers: serversFromTree(tree) };
  }
  addToTree(tree, name, ip);
  await writeTree(cfg, instanceId, tree);
  audit(cfg, "add_server", instanceId, { name, ip });
  return { added: true, servers: serversFromTree(tree) };
}

export async function removeServer(
  cfg: PrismConfig,
  instanceId: string,
  match: { name?: string; ip?: string },
  confirm?: boolean,
) {
  requireWritable(cfg);
  requireConfirm("remove_server", confirm);
  if (!match.name && !match.ip) throw new Error("remove_server needs a name or an ip to match");
  const tree = await readTree(cfg, instanceId);
  const removed = removeFromTree(tree, match);
  if (removed > 0) {
    await writeTree(cfg, instanceId, tree);
    audit(cfg, "remove_server", instanceId, { ...match, removed });
  }
  return { removed, servers: serversFromTree(tree) };
}
