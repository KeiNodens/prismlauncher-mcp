# Setup: connecting MCP clients to prism-mcp

prism-mcp is a standard **stdio MCP server**. Any MCP client can use it; only
the registration format differs. Build once:

```sh
cd prism-mcp
npm install
npm run build
```

All examples below assume the repo lives at `C:\dev\prism\prism-mcp` and use
the portable test data dir `C:\dev\prism\test-data`. For your real Prism data,
replace `--data-dir` with `%APPDATA%\PrismLauncher` (or drop the flag and let
auto-detection find it).

## Claude Code

Add to `.mcp.json` in your project (or `~/.claude.json` for user scope):

```json
{
  "mcpServers": {
    "prism": {
      "command": "node",
      "args": ["C:\\dev\\prism\\prism-mcp\\dist\\index.js", "--data-dir", "C:\\dev\\prism\\test-data"]
    }
  }
}
```

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.prism]
command = "node"
args = ["C:\\dev\\prism\\prism-mcp\\dist\\index.js", "--data-dir", "C:\\dev\\prism\\test-data"]
```

## Generic MCP clients (Claude Desktop, Hermes, Devin, …)

Use the same shape as the Claude Code example: a stdio server entry whose
`command` is `node` and whose `args` are the built `dist/index.js` plus
`--data-dir <dir>`. Add `--read-only` for a look-but-don't-touch connection.

Environment variables, if you prefer them over args:

| Variable | Meaning |
| --- | --- |
| `PRISM_DATA_DIR` | Prism data dir (same as `--data-dir`) |
| `PRISM_EXE` | Path to `prismlauncher.exe` (launch tool) |
| `PRISM_MCP_READ_ONLY` | `1` = disable mutation tools |

## Rin (Muse) — current arrangement

Rin reaches this server over the SSH route to the PC and speaks MCP over
stdio directly; no extra registration is needed until a persistent connector
is set up. The same server binary serves every client — nothing client-specific
lives in the server.

## One data dir per server process

Each prism-mcp process is bound to exactly one data dir. To let an agent work
on both a test dir and your real data, register two server entries with
different names (e.g. `prism-test`, `prism`) — and keep the real one
`--read-only` until you trust the workflow.

## NAS-backed instances (e.g. a Buffalo LinkStation)

Instances that live on the NAS (`\\<NAS>\Share\<game-folder>\minecraftinstance`)
are linked into `instances/` as per-instance symbolic links, so Prism and
prism-mcp see one flat list.

- A desktop session that already maps the NAS (e.g. drive `L:`) needs nothing.
- A session without NAS credentials (Rin's SSH session cannot see the
  interactive Credential Manager vault) needs the bootstrap: set
  `PRISM_NAS_BOOTSTRAP=1`. At startup prism-mcp runs
  `C:\dev\prism\tools\nas-mount.ps1`, which decrypts the DPAPI
  (LocalMachine-scope) credential stored in `C:\dev\prism\nas-cred.json`
  **inside the PC** and connects the share with `net use`. The password never
  appears in chat, command lines from outside, or this repository.
- One-time credential setup (desktop session, console prompt):
  `powershell -ExecutionPolicy Bypass -File C:\dev\prism\tools\setup-nas-cred-console.ps1`
- LocalMachine DPAPI means any local account on the PC can decrypt the blob.
  That trade-off was explicitly accepted by the owner for this home PC.
