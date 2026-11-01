# Agent guide: prismlauncher-mcp

[Human README](../README.md) | [日本語版](agent-guide.ja.md)

This document is written for AI agents that will call this MCP server. It
states the operating contract precisely: how to connect, which rules to
follow, and what every tool does. The schemas below were generated from the
running server (v0.8.0, 54 tools).

## What this server is

- A stdio MCP server that operates one Prism Launcher data directory at the
  file level (instances, mods, worlds, options, servers.dat) and delegates
  launching to Prism itself.
- It does not manage accounts and never touches anything outside its data
  directory.
- **Bridge preference (v0.6.0+):** when a bridge-enabled Prism (a Prism build
  with the agent bridge, or PrismLauncher-Agent headless) is running for the
  same data directory, `create_instance`, `launch_instance`, `stop_instance`,
  `set_setting`, and the instance settings tools (`set_instance_setting`,
  `get_instance_setting`, v0.7.0) are routed through the live app instead of
  files. v0.8.0 routes pack installs by project id (`install_modpack`) and
  instance exports (`export_instance`) through the app as managed-pack /
  export tasks, adds bridge-backed Java detection (`list_javas`,
  `diagnose_instance`), and passes single-player world targets to
  `launch_instance` through the bridge as well. In every case
  the results carry `viaBridge: true`. Routing is automatic, falls back to
  the file-level implementation on any failure, and can be disabled with
  the `PRISM_BRIDGE=0` environment variable. Check availability with
  `bridge_status`.

## Connecting

- Command: `node dist/index.js --data-dir <dataDir>` (or the published
  package binary `prismlauncher-mcp`). One process serves exactly one data
  directory.
- Environment: `PRISM_DATA_DIR` (data dir fallback), `PRISM_EXE` (path to
  prismlauncher.exe when not in the default location), `PRISM_MCP_READ_ONLY=1`
  (disable all mutations), `PRISM_NAS_BOOTSTRAP=1` (optional NAS mount hook).
- Tool results are JSON text content. `get_screenshot` returns image
  content. A tool failure comes back with `isError: true` and a plain-text
  reason - read it before retrying.

## Operating rules

1. Resolve ids from `list_instances`; never invent an instance id. Instance
   ids are directory names and may contain spaces and non-ASCII characters.
2. Read before you write: `get_instance` / `list_mods` first, so installs
   and updates target the state that actually exists.
3. Destructive tools (`delete_instance`, `stop_instance`, `remove_server`,
   pack overwrite in `build_lang_pack`) refuse to run without
   `confirm: true`. Get the user's agreement before passing it.
4. Mod auto-pick (both sources) selects the newest **release** matching the
   instance's Minecraft version and loader; beta/alpha is used only when no
   release matches. Pin an exact build with a version id (Modrinth) or file
   id (CurseForge) when the user asks for one.
5. Required dependencies are installed recursively and deduplicated;
   optional dependencies are reported, never installed. Conflicting version
   pins between parents are reported, first one wins. Author-declared
   incompatibilities are checked against the instance and surfaced as
   warnings.
6. CurseForge blocked files (the author disabled third-party distribution)
   are never scraped or fetched from mirrors. The tool records them and
   returns the mod-page URL; ask the user to download the file manually,
   then call `resolve_blocked_mods`.
7. CurseForge tools need the user's own API key, which the server reads
   from Prism's `FlameKeyOverride` setting. If a call says the key is
   missing, tell the user to set it in Prism (Settings, APIs). Never ask
   the user to paste a key to you.
8. The three translation tools run only on an explicit user request to
   translate. Never chain them automatically after an install.
9. Every mutation is audit-logged to
   `<dataDir>/prismlauncher-mcp/agent-ops.jsonl`, and overwritten or deleted
   files are backed up under `<dataDir>/prismlauncher-mcp/backups/`. Do not
   edit those state files directly.

## Workflows

- Set up a modded instance: `create_instance` (name, mcVersion, loader,
  loaderVersion) → `install_mod` / `install_mod_cf` for each mod →
  `launch_instance` → `wait_for_event` → `get_screenshot` to verify.
- Add a mod to an existing instance: `search_mods` (or `search_mods_cf`) →
  optionally `list_mod_versions` / `list_mod_files_cf` → install → report
  `installed`, `blocked`, `skippedOptionalDeps` and any
  `incompatibleWarnings` verbatim to the user.
- Update mods: `check_mod_updates` and/or `check_mod_updates_cf` → show the
  list → apply with `update_mod` / `update_mod_cf` after the user agrees.
- Import a pack: `import_modpack` for .mrpack, `import_modpack_cf` for
  CurseForge zips. Report `blocked` entries and their URLs to the user.
- Translate a mod (explicit request only): `extract_lang` → the user (or
  you, in files) translates under `lang-work/<slug>/translated/` →
  `check_lang_consistency` → `build_lang_pack`.

## Tool reference

### Instances

- **list_instances** — List Prism instances in the data dir with Minecraft/loader versions.
  Parameters: no parameters
- **get_instance** — Get one instance's settings (instance.cfg) and component pack (mmc-pack.json).
  Parameters: `id` (string, required)
- **create_instance** — Create an instance by writing instance.cfg + mmc-pack.json (Prism resolves the rest on first launch). Loader versions are resolved from the meta API (recommended build for the Minecraft version unless loaderVersion is given).
  Parameters: `name` (string, required), `mcVersion` (string, required), `loader` (string), `loaderVersion` (string), `iconKey` (string), `group` (string)
- **clone_instance** — Clone an instance directory under a new name (full copy, including worlds).
  Parameters: `id` (string, required), `newName` (string, required)
- **delete_instance** — Delete an instance directory. Destructive: requires confirm: true. Key files are backed up first.
  Parameters: `id` (string, required), `confirm` (boolean)
- **list_instance_settings** — Read the common per-instance settings in one call (Java path/args, memory, window, console, join-on-launch, with their Override gates). When a bridge-enabled Prism is running, values are the effective ones the app resolves; otherwise they are read from instance.cfg (absent keys report null).
  Parameters: `id` (string, required)
- **list_javas** — List the Java installations Prism detects on this machine, with probed versions. Requires a running bridge-enabled Prism.
  Parameters: no parameters
- **diagnose_instance** — Launch-readiness check for an instance: resolves the effective Java (configured path and its probed version), the Java major the instance's Minecraft version requires, and the effective memory settings, then reports concrete issues and warnings. Java probing uses a running bridge-enabled Prism; without one, version checks are skipped and the report says so.
  Parameters: `id` (string, required)
- **export_instance** — Export an instance as a Modrinth .mrpack (default) or a plain zip, into the data dir's prismlauncher-mcp/exports folder unless output is given. The mrpack format requires a running bridge-enabled Prism (the app resolves mod files against Modrinth); the zip format falls back to a file-level archive when no bridge is up. Logs, crash reports and backups are excluded either way.
  Parameters: `id` (string, required), `format` (mrpack|zip), `name` (string), `version` (string), `output` (string)
- **get_instance_setting** — Read one key from an instance's settings. When a bridge-enabled Prism is running, reports the effective value the app resolves (instance override when its gate is on, otherwise the global value); otherwise reads instance.cfg [General] directly and reports null when the key is absent there.
  Parameters: `id` (string, required), `key` (string, required)
- **set_instance_setting** — Set one key in an instance's settings. When a bridge-enabled Prism is running, the write goes through the app (a file-level write could be overwritten when the app saves on exit) and is verified by reading it back; otherwise instance.cfg is edited directly (backed up and audit-logged). Java and memory tweaks need their Override gate set too, e.g. OverrideJavaArgs=true with JvmArgs, OverrideMemory=true with MinMemAlloc/MaxMemAlloc, OverrideJavaLocation=true with JavaPath.
  Parameters: `id` (string, required), `key` (string, required), `value` (string, required)
- **list_groups** — List instance groups from instgroups.json.
  Parameters: no parameters
- **list_versions** — List versions from Prism's meta API. kind: 'minecraft' or a loader alias (forge/fabric/neoforge/quilt/liteloader) or a full meta uid.
  Parameters: `kind` (string, required), `limit` (number)

### Settings

- **get_settings** — Read global Prism settings (prismlauncher.cfg), one section at a time.
  Parameters: `section` (string)
- **set_setting** — Set one global Prism setting in prismlauncher.cfg. Backed up and audit-logged; reports requiresPrismRestart when Prism is currently running.
  Parameters: `key` (string, required), `value` (string, required), `section` (string)

### Mods - Modrinth

- **search_mods** — Search Modrinth. Matches against the instance when mcVersion/loader are omitted only if provided explicitly.
  Parameters: `query` (string, required), `loader` (string), `mcVersion` (string), `type` (string), `limit` (number)
- **list_mod_versions** — List a Modrinth project's versions (newest first). With instanceId, versions are annotated with matchesInstance and the auto-picked latest release is shown. Use a version's id with install_mod to pin or roll back a version.
  Parameters: `project` (string, required), `instanceId` (string)
- **install_mod** — Install a Modrinth project (id or slug) into an instance, choosing the version that matches the instance's Minecraft version and loader. Required dependencies are installed recursively and reported; optional dependencies are only reported.
  Parameters: `instance` (string, required), `project` (string, required), `type` (string), `versionId` (string)
- **list_mods** — List jars in an instance's mods folder with enabled state.
  Parameters: `instance` (string, required)
- **remove_mod** — Remove a mod jar from an instance (its packwiz index entry is removed too). Destructive: requires confirm: true. The jar is backed up first.
  Parameters: `instance` (string, required), `file` (string, required), `confirm` (boolean)
- **set_mod_enabled** — Enable/disable a mod by renaming the jar to/from the .disabled extension Prism uses.
  Parameters: `instance` (string, required), `file` (string, required), `enabled` (boolean, required)
- **check_mod_updates** — Check an instance's mod jars against Modrinth by sha1: reports current vs latest matching version per file (files unknown to Modrinth are marked known:false).
  Parameters: `instance` (string, required)
- **update_mod** — Update one mod jar to the latest Modrinth version matching the instance (the old jar is backed up before removal). Fails clearly when the file is unknown to Modrinth.
  Parameters: `instance` (string, required), `file` (string, required)
- **update_all_mods** — Update every mod in an instance that has a newer matching release, across Modrinth-managed and CurseForge-managed mods. Reports what was updated, how many were already current, and what failed. Prerelease-only updates are never applied silently (the same rule as check_mod_updates), and distribution-blocked CurseForge files are reported instead of attempted.
- **cross_check_mods** — Cross-source inventory: joins the Modrinth view (jars by sha1) with the CurseForge view (packwiz .index) by project slug. Reports bothInstalled (two different files = true duplicates), dualTracked (one file both sources recognize), availableOnBoth (installed from one source, also published on the other), single-source lists, and unknownJars. Jars with no index entry are also identified as CurseForge files by MurmurHash2 fingerprint (the modpack-bundled case; entries carry identifiedBy: "fingerprint"). Side effect: merges slug ↔ project-id pairs into `<dataDir>/prismlauncher-mcp/crossrefs.json`, which the bridge fork's mod search reads to mark cross-source installs as installed.
- **dedupe_mod** — For a slug reported as bothInstalled by cross_check_mods, removes the copy from the source NOT named by `keep` (jar + packwiz index entry; the jar is backed up first). Destructive: requires confirm: true. Refuses dualTracked slugs (only one file exists).
  Parameters: `instance` (string, required)

### Mods - CurseForge

- **search_mods_cf** — Search CurseForge for Minecraft mods (uses the user's own API key from Prism's FlameKeyOverride setting).
  Parameters: `query` (string, required), `gameVersion` (string), `loader` (string), `pageSize` (number)
- **list_mod_files_cf** — List a CurseForge mod's files. With instanceId, files are filtered to the instance's MC version/loader and the auto-picked latest release is shown. Use a file's fileId with install_mod_cf to pin or roll back a version.
  Parameters: `modId` (number, required), `instanceId` (string)
- **install_mod_cf** — Install a mod from CurseForge into an instance (latest release matching the instance's MC version/loader unless fileId is given; required dependencies are installed recursively). If the author disabled third-party distribution, the file comes back in `blocked` with its mod-page URL: ask the user to download it manually, then call resolve_blocked_mods. Never scrape CurseForge pages or use unofficial mirrors.
  Parameters: `instanceId` (string, required), `modId` (number, required), `fileId` (number)
- **list_blocked_mods** — List CurseForge files for an instance that are waiting for the user to download them manually.
  Parameters: `instanceId` (string, required)
- **resolve_blocked_mods** — Scan a folder for user-downloaded jars, sha1-match them against the instance's pending blocked CurseForge files, and place matches into the instance's mods folder.
  Parameters: `instanceId` (string, required), `folder` (string, required)
- **check_mod_updates_cf** — Check CurseForge mods for a newer release matching the instance: index-managed mods, plus unmanaged jars identified by fingerprint (flagged viaFingerprint / managed: false; update_mod_cf converts those to managed when it applies their update). A pick that is not newer than the installed file by date (e.g. the newest release vs a newer installed beta) is NOT proposed, so updates never downgrade. Read-only.
  Parameters: `instanceId` (string, required)
- **update_mod_cf** — Update one CurseForge-installed mod (by index slug or project id) to the latest release matching the instance; the old jar is backed up and removed.
  Parameters: `instanceId` (string, required), `mod` (string, required)

### Modpacks

- **import_modpack** — Import a Modrinth .mrpack file: creates the instance from the pack's declared Minecraft/loader versions, downloads every client file with sha1 verification, and extracts overrides.
  Parameters: `path` (string, required), `name` (string)
- **install_modpack** — Install a Modrinth modpack by project id or slug. When a bridge-enabled Prism is running, the app installs the pack itself and registers it as a managed pack (so Prism can check it for updates later). Otherwise the .mrpack is downloaded and imported at the file level. Packs whose client files include optional mods are refused by the bridge in headless mode (they need a dialog); the file-level fallback handles those.
  Parameters: `project` (string, required), `versionId` (string), `name` (string)
- **import_modpack_cf** — Import a CurseForge modpack zip (manifest.json format): creates the instance from the pack's Minecraft/loader declaration, installs every required file (blocked files are reported and recorded for manual download, per the blocked policy), and extracts overrides. Optional (required: false) files are reported, not installed.
  Parameters: `zipPath` (string, required), `name` (string)

### Worlds and options

- **list_worlds** — List single-player worlds (saves/) with level.dat info: name, version, game mode, seed, last played.
  Parameters: `instance` (string, required)
- **get_world** — Get one world's level.dat info by folder name.
- **copy_world** — Copy a world folder inside an instance under a new name (the copy's session.lock is dropped).
  Parameters: `instance` (string, required), `world` (string, required), `newName` (string, required)
- **backup_world** — Zip a world folder into the server's backups/worlds directory (under the data dir's prismlauncher-mcp folder) and return the backup path.
  Parameters: `instance` (string, required), `world` (string, required)
  Parameters: `instance` (string, required), `world` (string, required)
- **get_options** — Read the instance's minecraft/options.txt as key:value pairs.
  Parameters: `instance` (string, required)
- **set_option** — Set one key in the instance's options.txt. Backed up and audit-logged.
  Parameters: `instance` (string, required), `key` (string, required), `value` (string, required)

### Servers

- **list_servers** — List the multiplayer servers saved in the instance's servers.dat.
  Parameters: `instanceId` (string, required)
- **add_server** — Add a multiplayer server to the instance's servers.dat (created if missing). The previous file is backed up.
  Parameters: `instanceId` (string, required), `name` (string, required), `ip` (string, required)
- **remove_server** — Remove multiplayer server entries matching a name or ip from servers.dat. Destructive: needs confirm: true.
  Parameters: `instanceId` (string, required), `name` (string), `ip` (string), `confirm` (boolean)

### Game

- **bridge_status** — Check whether a bridge-enabled Prism (GUI or PrismLauncher-Agent headless) is running for this data dir. When available, launch/stop/create/set_setting route through the live app.
  Parameters: none
- **launch_instance** — Launch an instance through Prism (--launch). Prism/game start asynchronously.
  Parameters: `id` (string, required), `world` (string), `server` (string), `profile` (string), `offline` (string)
- **get_instance_status** — Running state (javaw command-line match), log presence and last log lines.
  Parameters: `id` (string, required)
- **tail_log** — Return the last lines of the instance's minecraft/logs/latest.log.
  Parameters: `id` (string, required), `lines` (number)
- **wait_for_event** — Wait until a regex matches a new line in latest.log (e.g. 'Setting user|Backend library|Stopping!'), or timeout.
  Parameters: `id` (string, required), `pattern` (string, required), `timeoutMs` (number)
- **stop_instance** — Kill the javaw process whose command line matches this instance exactly. Destructive: requires confirm: true.
  Parameters: `id` (string, required), `confirm` (boolean)
- **list_screenshots** — List screenshots in the instance's minecraft/screenshots folder.
  Parameters: `id` (string, required)
- **get_screenshot** — Fetch one screenshot as an image (visual launch verification).
  Parameters: `id` (string, required), `file` (string, required)

### Translation (explicit invocation only)

- **extract_lang** — Extract a mod jar's language files (assets/<modid>/lang/*) into prismlauncher-mcp/lang-work/<slug>/source for translation. Explicit use only.
  Parameters: `instanceId` (string), `modFile` (string), `jarPath` (string)
- **check_lang_consistency** — Compare translated lang files against the extracted source: missing/extra keys, placeholder and format-code mismatches, untranslated leftovers. Read-only.
  Parameters: `slug` (string, required), `sourceLocale` (string), `targetLocale` (string)
- **build_lang_pack** — Build a resource pack zip from prismlauncher-mcp/lang-work/<slug>/translated and install it into an instance's resourcepacks. Overwriting an existing pack needs confirm: true.
  Parameters: `slug` (string, required), `instanceId` (string, required), `packName` (string), `description` (string), `confirm` (boolean)

