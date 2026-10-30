# prism-mcp

An MCP (Model Context Protocol) server that lets an AI agent operate
[Prism Launcher](https://prismlauncher.org/) at the **file level** — create
instances, install mods from Modrinth, launch the game, read logs and fetch
screenshots — without modifying the stock launcher.

This is Layer 1 of the `prism` project (see `../PLAN.md`). Layer 2
(`prism-bridge`, a patched Prism fork) adds live operations later; everything
here works with an unmodified Prism Launcher installation.

## How it works

Prism keeps almost everything an agent needs in plain files:

| Concern | File |
| --- | --- |
| Instance definition | `instances/<id>/instance.cfg` (INI) + `mmc-pack.json` |
| Component versions | [meta.prismlauncher.org](https://meta.prismlauncher.org/v1/) API |
| Mods | `instances/<id>/minecraft/mods/*.jar` + `.index/<slug>.pw.toml` (packwiz format) |
| Logs | `instances/<id>/minecraft/logs/latest.log` |
| Screenshots | `instances/<id>/minecraft/screenshots/*.png` |

Launching still goes through Prism itself (`prismlauncher --launch <id>`), so
accounts, Java resolution and downloads stay in Prism's hands.

## Safety model

- **Destructive tools require `confirm: true`** (`delete_instance`, `stop_instance`).
- Files that would be overwritten or deleted are first copied to
  `prism-mcp/backups/<timestamp>/` inside the data dir.
- **Every mutation is audit-logged** to `prism-mcp/agent-ops.jsonl` in the data dir.
- `--read-only` (or `PRISM_MCP_READ_ONLY=1`) disables all mutation tools.
- The server only ever touches the single data dir it was started with.

## Quick start

```sh
npm install
npm run build
node dist/index.js --data-dir C:\path\to\PrismLauncher-data
```

Data dir resolution order:

1. `--data-dir` argument, or the `PRISM_DATA_DIR` environment variable
2. `UserData/` next to the executable (portable installs), if initialized
3. `%APPDATA%\PrismLauncher`

Set `PRISM_EXE` to point at `prismlauncher.exe` if it is not in the default
install location (`%LOCALAPPDATA%\Programs\PrismLauncher`) or on `PATH`.

## Tools

**Instances:** `list_instances`, `get_instance`, `create_instance`,
`delete_instance`, `list_groups`, `list_versions`

**Mods (Modrinth):** `search_mods`, `install_mod` (required dependencies are
installed recursively and reported; optional ones are only reported),
`list_mods`

**Game:** `launch_instance`, `get_instance_status`, `tail_log`,
`wait_for_event`, `stop_instance`, `list_screenshots`, `get_screenshot`

## Connecting an MCP client

See [docs/setup.md](docs/setup.md) for Claude Code, Codex and generic MCP
client configuration.

## Status

v0.1.0 — Phase 1 demo path implemented and verified end-to-end at the file
level (create instance → install mod → files validated). The final launch leg
requires running Prism in a desktop session.

## License

MIT
