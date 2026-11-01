# prismlauncher-mcp

[English](README.md) | 日本語

AIエージェントが [Prism Launcher](https://prismlauncher.org/) を**ファイルレベルで**操作するための
MCP（Model Context Protocol）サーバです。インスタンスの作成、Modrinth / CurseForge からの
mod 導入、ゲームの起動、ログの読み取り、スクリーンショットの取得までを、素のランチャーに
一切手を入れずに行えます。さらに、mod の翻訳支援ツール（言語ファイルの抽出、整合性チェック、
言語パックのビルド）を備えていますが、これらは明示的に呼ばれたときだけ動作します。

本プロジェクトは `prism` プロジェクトの Layer 1 です。Layer 2（`prism-bridge`、Prism 本体への
パッチによるライブ操作）は後段で追加されますが、ここにある機能はすべて無改変の Prism Launcher
インストールで動作します。

## 仕組み

Prism はエージェントが必要とする情報のほぼすべてをプレーンなファイルで保持しています:

| 対象 | ファイル |
| --- | --- |
| インスタンス定義 | `instances/<id>/instance.cfg`（INI）+ `mmc-pack.json` |
| コンポーネントのバージョン | [meta.prismlauncher.org](https://meta.prismlauncher.org/v1/) API |
| Mod | `instances/<id>/minecraft/mods/*.jar` + `.index/<slug>.pw.toml`（packwiz 形式） |
| ログ | `instances/<id>/minecraft/logs/latest.log` |
| スクリーンショット | `instances/<id>/minecraft/screenshots/*.png` |

起動は Prism 本体（`prismlauncher --launch <id>`）に任せるため、アカウント管理、
Java の解決、ダウンロードは引き続き Prism が担当します。

## 翻訳支援（明示的な呼び出し専用）

mod の言語ファイル翻訳を支援する3つのツールです。他のツールから自動で起動されることは
決してなく、クライアントが直接呼んだときだけ動作します。

1. `extract_lang` — mod の jar から `assets/<modid>/lang/*` を取り出し、
   `prismlauncher-mcp/lang-work/<slug>/source/` に展開する
2. `lang-work/<slug>/translated/` に翻訳を作り（相対パスは source と同じ、ファイル名は
   対象ロケールのもの）、`check_lang_consistency` — 原文ロケールに対するキー欠落・余分なキー、
   プレースホルダ / フォーマットコードの不一致、未翻訳の残りを報告する
3. `build_lang_pack` — `translated/` をリソースパックとして zip 化し、インスタンスの
   `resourcepacks/` に入れる（既存パックの上書きには `confirm: true` が必要で、事前に
   バックアップされる）

## 安全性のモデル

- **破壊的ツールは `confirm: true` が必須**（`delete_instance`、`stop_instance` など）
- 上書き・削除されるファイルは、まずデータフォルダ内の
  `prismlauncher-mcp/backups/<timestamp>/` にコピーされる
- **すべての変更操作は監査ログに記録される**（データフォルダ内の
  `prismlauncher-mcp/agent-ops.jsonl`）
- `--read-only`（または `PRISM_MCP_READ_ONLY=1`）で全変更ツールを無効化できる
- サーバが触るのは、起動時に指定された単一のデータフォルダだけ

## クイックスタート

```sh
npm install
npm run build
node dist/index.js --data-dir C:\path\to\PrismLauncher-data
```

データフォルダの解決順:

1. `--data-dir` 引数、または環境変数 `PRISM_DATA_DIR`
2. 実行ファイル隣の `UserData/`（ポータブル版、初期化済みの場合）
3. `%APPDATA%\PrismLauncher`

`prismlauncher.exe` が既定のインストール先（`%LOCALAPPDATA%\Programs\PrismLauncher`）
になく `PATH` にも無い場合は、環境変数 `PRISM_EXE` で指定してください。

## ツール一覧

**インスタンス:** `list_instances`, `get_instance`, `create_instance`,
`clone_instance`, `delete_instance`, `set_instance_setting`,
`get_instance_setting`, `list_instance_settings`（主要キーの実効値を一括取得）,
`list_groups`, `list_versions`, `export_instance`（.mrpack はブリッジ経由、
またはプレーン zip）, `diagnose_instance`（起動可否診断: 実効 Java と
Minecraft が要求する Java の照合、メモリ、具体的な問題点）, `list_javas`

**設定:** `get_settings`, `set_setting`（全体設定 `prismlauncher.cfg`）

**Mod（Modrinth）:** `search_mods`, `install_mod`, `list_mods`, `remove_mod`,
`set_mod_enabled`, `check_mod_updates`, `update_mod`, `update_all_mods`
（更新のある mod を Modrinth / CurseForge 両方まとめて更新。プレリリースのみの
更新は勝手に適用しません）, `list_mod_versions`
（バージョン一覧。`install_mod` にバージョンIDを渡すと固定・巻き戻しが可能）。
必須依存は再帰的に導入され、重複は排除されます（同一ファイルが既にあれば再ダウンロードしない）。
親同士で相容れないバージョン固定があった場合は報告され、作者が宣言した非互換 mod は
インスタンス内と照合して警告されます。任意依存は導入されず報告のみです。

**クロスソース:** `cross_check_mods`（Modrinth の所持リストと CurseForge の
所持リストをプロジェクトのスラッグで突き合わせ。両方から入っている真の重複、
両ソースが認識する単一ファイル、もう片方のプラットフォームにも存在する mod、
どちらでも特定できない jar を分類して報告。あわせて slug ⇔ 両プロジェクトIDの
対応表を `<dataDir>/prismlauncher-mcp/crossrefs.json` に記録し、フォーク版
Prism の mod 検索がクロスソースの導入済み表示に使います）,
`dedupe_mod`（真の重複について、残す側を指定して他方のコピーを除去。除去前にバックアップ）

**CurseForge:** `search_mods_cf`, `list_mod_files_cf`（ファイル一覧。`install_mod_cf` に
ファイルIDを渡すと固定・巻き戻しが可能）, `install_mod_cf`（必須依存は再帰導入。
作者が第三者配布を無効化したファイルは `blocked` として、mod ページの URL とともに
報告されます — スクレイピング等の回避は一切しません）, `list_blocked_mods`,
`resolve_blocked_mods`（ユーザーが手動でダウンロードしたファイルを sha1 照合して配置）,
`check_mod_updates_cf`, `update_mod_cf`。APIキーはユーザー自身のものを Prism の
`FlameKeyOverride` 設定から読みます。

**Modpack:** `import_modpack`（.mrpack: パックの依存宣言からインスタンスを生成し、
sha1 検証付きでダウンロード、overrides を展開）, `install_modpack`
（Modrinth のプロジェクトID指定。ブリッジ稼働時はアプリ自身が managed pack として
導入するので、後から Prism の更新チェック対象になります。ブリッジが無ければ
.mrpack をダウンロードしてファイルレベルで取り込み）, `import_modpack_cf`
（CurseForge 形式 zip: manifest からインスタンスを生成し、必須ファイルを blocked と
同じ方針で全数導入、overrides を展開）

**ワールドと設定ファイル:** `list_worlds`, `get_world`（level.dat）, `copy_world`,
`backup_world`（サーバの backups へ zip 化）, `get_options`,
`set_option`（options.txt）

**サーバ:** `list_servers`, `add_server`, `remove_server`（servers.dat を NBT レベルで
編集し、既存エントリの未知フィールドは保持します）

**ゲーム:** `launch_instance`, `get_instance_status`, `tail_log`,
`wait_for_event`, `stop_instance`, `list_screenshots`, `get_screenshot`

**翻訳（明示呼び出し専用）:** `extract_lang`, `check_lang_consistency`,
`build_lang_pack` — 上記「翻訳支援」セクション参照

## MCP クライアントとの接続

Claude Code、Codex、その他の MCP クライアント向け設定は
[docs/setup.md](docs/setup.md) を参照してください。

AIエージェント向け: [docs/agent-guide.ja.md](docs/agent-guide.ja.md)（運用ルール、ワークフロー、全ツールリファレンス）

## ステータス

v0.8.0 — Phase 1（ファイルレベル操作）は実装・検証済みです。一気通貫デモ
（インスタンス作成 → mod 導入 → 起動 → タイトル画面のスクリーンショット確認）、
Modrinth / CurseForge の依存解決つき導入、更新チェック、Modpack 取り込み
（.mrpack / CurseForge 形式）、翻訳支援ツールまでを含みます。v0.6.0 では
Phase 2 のブリッジ接続が加わり、ブリッジ有効な Prism が起動中のデータフォルダでは
作成/起動/停止/設定書き込みが起動中のアプリ経由になります（`bridge_status` 参照）。
v0.7.0 ではインスタンス個別設定（`set_instance_setting` と新ツール
`get_instance_setting`）もブリッジ経由になり、Prism 起動中のままで Java
引数やメモリ上限を安全に変更できます。
v0.8.0 では `list_instance_settings`、`export_instance`、`install_modpack`、
`update_all_mods`、ワールドのコピー/バックアップ、Java ツール群
（`list_javas`、`diagnose_instance`）が加わり、ブリッジ v1.3 では
シングルプレイのワールドも起動ターゲットに指定できます。
v0.9.0 ではクロスソース系ツール（`cross_check_mods`、`dedupe_mod`）が加わりました。
再現可能な
スモークテストが `scripts/smoke.mjs` にあります。

## ライセンス

MIT
