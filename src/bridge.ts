import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { PrismConfig } from "./config.js";
import { mcpHome } from "./config.js";

// Client for the PrismLauncher agent bridge (Phase 2): a JSON-RPC server
// inside a running PrismLauncher (or PrismLauncher-Agent headless) exposed
// over a same-user named pipe. When a bridge is up, operations that benefit
// from the live app (launch, stop, create, global setting writes) are routed
// through it; everything else keeps using the file-level implementation.
// Set PRISM_BRIDGE=0 to disable routing entirely.

interface BridgeInfo {
  socketName: string;
  pid: number;
  startedAt?: string;
  protocol?: number;
}

let cached: { dataDir: string; info: BridgeInfo } | null = null;
let cachedAlive = false;

export function bridgeEnabled(): boolean {
  return process.env.PRISM_BRIDGE !== "0";
}

function readBridgeInfo(dataDir: string): BridgeInfo | null {
  try {
    const raw = fs.readFileSync(path.join(mcpHome(dataDir), "bridge.json"), "utf8");
    const parsed = JSON.parse(raw) as BridgeInfo;
    if (typeof parsed.socketName === "string" && typeof parsed.pid === "number") return parsed;
  } catch {
    /* no bridge running */
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// One-shot JSON-RPC call: connect, send one framed request, await the
// response with the matching id, close. Framing is a 4-byte big-endian
// length prefix followed by UTF-8 JSON (same as tools/prism-ctl.mjs).
export function bridgeCall(info: BridgeInfo, method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const pipePath = `\\\\.\\pipe\\${info.socketName}`;
    const socket = net.createConnection(pipePath);
    const id = 1;
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`bridge call ${method} timed out`)), timeoutMs);

    function finish(err: Error | null, value?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    }

    socket.on("error", (err) => finish(err));
    socket.on("connect", () => {
      const payload = Buffer.from(JSON.stringify({ id, method, params: params ?? {} }), "utf8");
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32BE(payload.length, 0);
      payload.copy(frame, 4);
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) break;
        const body = buffer.subarray(4, 4 + len).toString("utf8");
        buffer = buffer.subarray(4 + len);
        let message: { id?: number; result?: unknown; error?: { code?: string; message?: string } };
        try {
          message = JSON.parse(body);
        } catch {
          continue;
        }
        if (message.id !== id) continue; // notification or stray frame
        if (message.error) finish(new Error(`bridge ${method}: ${message.error.message ?? message.error.code ?? "error"}`));
        else finish(null, message.result);
        return;
      }
    });
    socket.on("close", () => finish(new Error(`bridge connection closed during ${method}`)));
  });
}

// Returns bridge info when a live bridge answers ping, else null. The
// positive result is cached per data dir; failures are not cached, so a
// bridge started later is picked up on the next call.
export async function discoverBridge(cfg: PrismConfig): Promise<BridgeInfo | null> {
  if (!bridgeEnabled()) return null;
  if (cached && cached.dataDir === cfg.dataDir && cachedAlive) return cached.info;
  const info = readBridgeInfo(cfg.dataDir);
  if (!info || !pidAlive(info.pid)) {
    cached = null;
    cachedAlive = false;
    return null;
  }
  try {
    await bridgeCall(info, "ping", {}, 3000);
  } catch {
    cached = null;
    cachedAlive = false;
    return null;
  }
  cached = { dataDir: cfg.dataDir, info };
  cachedAlive = true;
  return info;
}

// Route one call through the bridge when available. Returns undefined when
// no bridge is up (caller falls back to the file-level implementation) and
// rethrows bridge errors after a successful discovery only when the call
// itself fails at the protocol level; application errors (error responses)
// also fall back, because the file-level path may still succeed and the
// bridge is an optimization, not a requirement. Fallbacks are noted on
// stderr for diagnosis.
export async function tryBridge<T>(cfg: PrismConfig, method: string, params: unknown, timeoutMs?: number): Promise<T | undefined> {
  const info = await discoverBridge(cfg);
  if (!info) return undefined;
  try {
    return (await bridgeCall(info, method, params, timeoutMs)) as T;
  } catch (err) {
    cachedAlive = false;
    console.error(`[prismlauncher-mcp] bridge ${method} failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export async function bridgeStatus(cfg: PrismConfig) {
  const info = readBridgeInfo(cfg.dataDir);
  if (!info) return { available: false, reason: "no bridge.json (no bridge-enabled Prism is running for this data dir)" };
  const alive = pidAlive(info.pid);
  if (!alive) return { available: false, reason: `bridge pid ${info.pid} is not running (stale bridge.json)`, socketName: info.socketName, pid: info.pid };
  try {
    const pong = await bridgeCall(info, "ping", {}, 3000);
    return { available: true, socketName: info.socketName, pid: info.pid, startedAt: info.startedAt, protocol: info.protocol, ping: pong };
  } catch (err) {
    return { available: false, reason: `ping failed: ${err instanceof Error ? err.message : String(err)}`, socketName: info.socketName, pid: info.pid };
  }
}
