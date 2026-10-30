// Repeatable smoke test: spawns the built server over stdio and exercises
// the demo path against a data dir.
//   node scripts/smoke.mjs [dataDir]
// Defaults to C:\dev\prism\test-data. Creates a throwaway instance, installs
// JEI into it, and deletes it again (confirm path included).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.argv[2] ?? "C:\\dev\\prism\\test-data";
const NAME = "smoke-test-instance";

const child = spawn("node", [path.join(root, "dist", "index.js"), "--data-dir", dataDir], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, PRISM_NAS_BOOTSTRAP: process.env.PRISM_NAS_BOOTSTRAP ?? "" },
});

let buffer = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}
async function tool(name, args) {
  const res = await call("tools/call", { name, arguments: args });
  const text = res.result.content[0].text;
  if (res.result.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const init = await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
console.log("server:", init.result.serverInfo);
notify("notifications/initialized");

const before = await tool("list_instances", {});
console.log(`instances before: ${before.length}`);
if (before.some((i) => i.id === NAME)) const upd = await tool("check_mod_updates", { instance: NAME });
console.log("update check:", JSON.stringify(upd[0]));

const disabled = await tool("set_mod_enabled", { instance: NAME, file: installed.file, enabled: false });
console.log("disabled:", disabled.file);
const enabled = await tool("set_mod_enabled", { instance: NAME, file: disabled.file, enabled: true });
console.log("re-enabled:", enabled.file, enabled.changed);

await tool("set_option", { instance: NAME, key: "fov", value: "0.5" });
const opts = await tool("get_options", { instance: NAME });
console.log("option fov:", opts.fov);

const clone = await tool("clone_instance", { id: NAME, newName: NAME + "-clone" });
console.log("cloned:", clone.id);
await tool("delete_instance", { id: clone.id, confirm: true });

await tool("delete_instance", { id: NAME, confirm: true });

const created = await tool("create_instance", { name: NAME, mcVersion: "1.20.1", loader: "forge" });
console.log("created:", created.id, created.components.map((c) => `${c.uid}@${c.version}`).join(", "));

const installed = await tool("install_mod", { instance: NAME, project: "jei" });
console.log("installed:", installed.project, installed.version, installed.file);

const mods = await tool("list_mods", { instance: NAME });
console.log("mods in instance:", mods.length);

await tool("delete_instance", { id: NAME, confirm: true });
const after = await tool("list_instances", {});
console.log(`instances after cleanup: ${after.length}`);
console.log("SMOKE OK");
child.kill();
process.exit(0);
