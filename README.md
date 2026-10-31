# prismlauncher-mcp

English | [日本語](README.ja.md)

An MCP (Model Context Protocol) server that lets an AI agent operate
[Prism Launcher](https://prismlauncher.org/) at the **file level** — create
instances, install mods from Modrinth, launch the game, read logs and fetch
screenshots — without modifying the stock launcher. It also carries
mod-translation support tools (lang extraction, consistency checks and
language-pack building) that run only when explicitly called.

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

## Translation support (explicit invocation only)

Three tools support translating mod language files. They are never triggered
automatically by other tools; a client must call them directly.

1. `extract_lang` — pull `assets/<modid>/lang/*` out of a mod jar into
   `prismlauncher-mcp/lang-work/<slug>/source/`.
2. Translate into `lang-work/<slug>/translated/` (same relative paths,
   target-locale file names), then `check_lang_consistency` — reports missing
   and extra keys, placeholder / format-code mismatches and untranslated
   leftovers against the source locale.
3. `build_lang_pack` — zip `translated/` into a resource pack and install it
   into an instance's `resourcepacks/` (overwriting an existing pack needs
   `confirm: true` and is backed up first).

## Safety model

- **Destructive tools require `confirm: true`** (`delete_instance`, `stop_instance`).
- Files that would be overwritten or deleted are first copied to
  `prismlauncher-mcp/backups/<timestamp>/` inside the data dir.
- **Every mutation is audit-logged** to `prismlauncher-mcp/agent-ops.jsonl` in the data dir.
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
`clone_instance`, `delete_instance`, `set_instance_setting`,
`get_instance_setting`, `list_groups`,
`list_versions`

**Settings:** `get_settings`, `set_setting` (global `prismlauncher.cfg`)

**Mods (Modrinth):** `search_mods`, `install_mod` (required dependencies are
installed recursively and reported; optional ones are only reported),
`list_mods`, `remove_mod`, `set_mod_enabled`, `check_mod_updates`, `update_mod`,
`list_mod_versions` (browse versions; pass a version id to `install_mod` to
pin or roll back). Required dependencies are installed recursively with
deduplication: an identical file already present is not downloaded again,
conflicting version pins between parents are reported, and author-declared
incompatible mods are checked against the instance and warned about

**CurseForge:** `search_mods_cf`, `list_mod_files_cf` (browse files; pass a
file id to `install_mod_cf` to pin or roll back), `install_mod_cf` (required dependencies
recursively; files whose authors disabled third-party distribution come back
as `blocked` with a mod-page URL for manual download — no scraping, ever),
`list_blocked_mods`, `resolve_blocked_mods` (sha1-matched placement of
user-downloaded files), `check_mod_updates_cf`, `update_mod_cf`. Uses the user's own API key from Prism's
`FlameKeyOverride` setting.

**Modpacks:** `import_modpack` (.mrpack: instance creation from the pack's
declared dependencies, sha1-verified downloads, overrides extraction),
`import_modpack_cf` (CurseForge zip: instance from the manifest, every
required file installed under the same blocked policy, overrides extracted)

**Worlds & options:** `list_worlds`, `get_world` (level.dat), `get_options`,
`set_option` (options.txt)

**Servers:** `list_servers`, `add_server`, `remove_server` (servers.dat,
NBT-level edits that preserve unknown fields on existing entries)

**Game:** `launch_instance`, `get_instance_status`, `tail_log`,
`wait_for_event`, `stop_instance`, `list_screenshots`, `get_screenshot`

**Translation (explicit only):** `extract_lang`, `check_lang_consistency`, `build_lang_pack` — see the Translation support section above.

## Connecting an MCP client

See [docs/setup.md](docs/setup.md) for Claude Code, Codex and generic MCP
client configuration.

For AI agents: [docs/agent-guide.md](docs/agent-guide.md) (operating rules, workflows, full tool reference).

## Status

v0.7.0 — Phase 1 (file-level operation) is implemented and verified,
including the end-to-end demo (create instance → install mod → launch →
title-screen screenshot), dependency-aware installs from Modrinth and
CurseForge, update checks, modpack import (.mrpack and CurseForge zip),
servers.dat editing and the translation support tools. v0.6.0 adds the
Phase 2 bridge transport: when a bridge-enabled Prism is running for the
data directory, create/launch/stop/set_setting route through the live app
(see `bridge_status`). v0.7.0 extends bridge routing to per-instance
settings (`set_instance_setting`, plus the new `get_instance_setting`),
so Java arguments and memory limits can be changed safely while Prism
is running. A repeatable smoke
test lives in `scripts/smoke.mjs`.

## License

MIT
