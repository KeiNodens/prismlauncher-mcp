# エージェント用ガイド: prismlauncher-mcp

[人間用 README](../README.ja.md) | [English](agent-guide.md)

この文書は、この MCP サーバを呼び出す AI エージェントに向けて書かれています。
接続方法、守るべき運用ルール、全ツールの仕様を正確に記します。以下のスキーマは
稼働中サーバ（v0.8.0、全54ツール）から生成したものです。

## このサーバについて

- Prism Launcher のデータフォルダ1つをファイルレベルで操作する stdio MCP サーバ
  です（インスタンス、mod、ワールド、options、servers.dat）。起動は Prism 本体に
  委譲します。
- アカウント管理は行いません。データフォルダの外には一切触れません。
- **ブリッジ優先（v0.6.0+）:** 同じデータフォルダでブリッジ有効な Prism（エージェント
  ブリッジ入りビルド、または PrismLauncher-Agent ヘッドレス）が起動中の場合、
  `create_instance` / `launch_instance` / `stop_instance` / `set_setting` と
  インスタンス個別設定（`set_instance_setting` / `get_instance_setting`、v0.7.0）は
  ファイルではなく起動中のアプリ経由で実行され、結果に `viaBridge: true` が付きます。
  v0.8.0 ではプロジェクトID指定のパック導入（`install_modpack`）とインスタンスの
  エクスポート（`export_instance`）もアプリの managed pack / エクスポートタスク経由に
  なり、Java 検出（`list_javas`、`diagnose_instance`）がブリッジ backed に加わり、
  `launch_instance` のシングルプレイワールド指定もブリッジ経由になりました。
  ルーティングは自動で、失敗時はファイルレベル実装にフォールバックします。
  環境変数 `PRISM_BRIDGE=0` で無効化できます。可用性は `bridge_status` で確認できます。

## 接続

- コマンド: `node dist/index.js --data-dir <dataDir>`（または公開パッケージの
  バイナリ `prismlauncher-mcp`）。1プロセスが扱うデータフォルダは1つだけです。
- 環境変数: `PRISM_DATA_DIR`（データフォルダの代替指定）、`PRISM_EXE`
  （prismlauncher.exe の場所が既定と異なる場合）、`PRISM_MCP_READ_ONLY=1`
  （全変更を無効化）、`PRISM_NAS_BOOTSTRAP=1`（任意の NAS マウントフック）
- ツールの結果は JSON テキストで返ります。`get_screenshot` は画像を返します。
  失敗時は `isError: true` と理由テキストが返るので、リトライ前に必ず読んで
  ください。

## 運用ルール

1. インスタンスIDは `list_instances` で解決し、推測で作らないこと。IDは
   ディレクトリ名そのもので、空白や非ASCII文字を含むことがあります。
2. 書く前に読む: `get_instance` / `list_mods` で実際の状態を確認してから
   導入・更新を行うこと。
3. 破壊的ツール（`delete_instance`、`stop_instance`、`remove_server`、
   `build_lang_pack` のパック上書き）は `confirm: true` 無しでは動きません。
   渡す前にユーザーの同意を得ること。
4. mod の自動選択（両ソース共通）は、インスタンスの MC バージョンとローダーに
   合う最新の **release** を選びます。beta/alpha は release が無い場合のみ。
   特定ビルドの指定はバージョンID（Modrinth）/ ファイルID（CurseForge）で。
5. 必須依存は再帰導入され重複排除されます。任意依存は報告のみで導入され
   ません。親同士の版固定が衝突した場合は報告され、先勝ちです。作者宣言の
   非互換はインスタンス内と照合され、警告として返ります。
6. CurseForge の blocked ファイル（作者が第三者配布を無効化）は、スクレイ
   ピングやミラー取得を決してしません。ツールが記録し mod ページ URL を
   返すので、ユーザーに手動ダウンロードを依頼し、配置は
   `resolve_blocked_mods` で行ってください。
7. CurseForge 系ツールにはユーザー自身の API キーが必要で、サーバは Prism の
   `FlameKeyOverride` 設定から読みます。キーが無いと返ったら、Prism の
   設定（APIs）で入れるよう案内してください。キー自体をチャットで聞くのは
   禁止です。
8. 翻訳系の3ツールは、ユーザーが翻訳を明示的に依頼したときだけ使うこと。
   導入のついでに自動で繋げないこと。
9. すべての変更は `<dataDir>/prismlauncher-mcp/agent-ops.jsonl` に監査ログ
   され、上書き・削除ファイルは `<dataDir>/prismlauncher-mcp/backups/` に
   バックアップされます。この状態ファイル群を直接編集しないこと。

## ワークフロー

- mod 環境の新規構築: `create_instance`（name、mcVersion、loader、
  loaderVersion）→ 各 mod を `install_mod` / `install_mod_cf` →
  `launch_instance` → `wait_for_event` → `get_screenshot` で確認
- 既存インスタンスへの mod 追加: `search_mods`（または `search_mods_cf`）→
  必要なら `list_mod_versions` / `list_mod_files_cf` → 導入 → 結果の
  `installed` / `blocked` / `skippedOptionalDeps` / `incompatibleWarnings`
  をそのままユーザーに報告
- mod の更新: `check_mod_updates` と `check_mod_updates_cf` で一覧 →
  ユーザーの同意後に `update_mod` / `update_mod_cf` を適用
- パック取り込み: .mrpack は `import_modpack`、CurseForge zip は
  `import_modpack_cf`。`blocked` のエントリと URL はユーザーに報告すること
- mod の翻訳（明示依頼時のみ）: `extract_lang` → `lang-work/<slug>/translated/`
  に翻訳を作成 → `check_lang_consistency` → `build_lang_pack`

## ツールリファレンス

### インスタンス

- **list_instances** — 全インスタンスの一覧（id、MCバージョン、ローダー）
  引数: no parameters
- **get_instance** — 1インスタンスの詳細
  引数: `id` (string, required)
- **create_instance** — 新規インスタンス作成（名前重複はエラー）
  引数: `name` (string, required), `mcVersion` (string, required), `loader` (string), `loaderVersion` (string), `iconKey` (string), `group` (string)
- **clone_instance** — インスタンスの複製
  引数: `id` (string, required), `newName` (string, required)
- **delete_instance** — インスタンス削除（confirm必須）
  引数: `id` (string, required), `confirm` (boolean)
- **list_instance_settings** — インスタンスの主要設定を実効値で一括取得（Java パス/引数、メモリ、ウィンドウ、コンソール、起動時ジョインと各 Override ゲート）。ブリッジ有効な Prism が起動中の場合はアプリが解決する実効値、それ以外は instance.cfg から読み、無いキーは null
  引数: `id` (string, required)
- **list_javas** — Prism が検出する Java 一覧（バージョン実測つき）。ブリッジ有効な Prism の起動が必須
  引数: なし
- **diagnose_instance** — 起動可否診断: 実効 Java（設定パスと実測バージョン）、その Minecraft が要求する Java メジャー、実効メモリを解決し、具体的な問題と警告を返す。Java の実測はブリッジ有効な Prism 経由。無ければバージョン照合をスキップし、その旨を報告する
  引数: `id` (string, required)
- **export_instance** — インスタンスを Modrinth .mrpack（既定）またはプレーン zip でエクスポート。出力先は既定でデータフォルダの prismlauncher-mcp/exports。.mrpack はブリッジ有効な Prism が必須（アプリが Modrinth と照合して解決）、zip はブリッジが無ければファイルレベルのアーカイブにフォールバック。ログ・クラッシュレポート・バックアップはどちらでも除外
  引数: `id` (string, required), `format` (mrpack|zip), `name` (string), `version` (string), `output` (string)
- **get_instance_setting** — インスタンス個別設定の取得。ブリッジ有効な Prism が起動中の場合はアプリが解決する実効値（ゲート有効時はインスタンスの上書き、無効時は全体設定の値）を返し、それ以外は instance.cfg の [General] を直接読み、キーが無ければ null を返す
  引数: `id` (string, required), `key` (string, required)
- **set_instance_setting** — インスタンス個別設定の変更。ブリッジ有効な Prism が起動中の場合はアプリ経由で書き込み、読み戻して検証する（ファイル直書きはアプリ終了時の保存で上書きされ得るため）。それ以外は instance.cfg を直接編集（バックアップ・監査ログ付き）。Java 引数やメモリの変更には対応する Override ゲートも必要（例: JvmArgs には OverrideJavaArgs=true、MinMemAlloc/MaxMemAlloc には OverrideMemory=true、JavaPath には OverrideJavaLocation=true）
  引数: `id` (string, required), `key` (string, required), `value` (string, required)
- **list_groups** — グループ一覧
  引数: no parameters
- **list_versions** — 利用可能なMC/ローダーのバージョン一覧
  引数: `kind` (string, required), `limit` (number)

### 設定

- **get_settings** — 全体設定 prismlauncher.cfg の参照
  引数: `section` (string)
- **set_setting** — 全体設定の変更
  引数: `key` (string, required), `value` (string, required), `section` (string)

### Mod - Modrinth

- **search_mods** — Modrinthでmod検索（インスタンス適合フィルタ付き）
  引数: `query` (string, required), `loader` (string), `mcVersion` (string), `type` (string), `limit` (number)
- **list_mod_versions** — Modrinthのバージョン一覧（固定・巻き戻し用）
  引数: `project` (string, required), `instanceId` (string)
- **install_mod** — Modrinthから導入（必須依存は再帰導入、任意依存は報告のみ）
  引数: `instance` (string, required), `project` (string, required), `type` (string), `versionId` (string)
- **list_mods** — 導入済みmod一覧
  引数: `instance` (string, required)
- **remove_mod** — modの削除
  引数: `instance` (string, required), `file` (string, required), `confirm` (boolean)
- **set_mod_enabled** — modの有効/無効切り替え
  引数: `instance` (string, required), `file` (string, required), `enabled` (boolean, required)
- **check_mod_updates** — Modrinth導入分の更新チェック
  引数: `instance` (string, required)
- **update_mod** — Modrinth導入分の更新適用
- **update_all_mods** — 更新のある mod を全件更新（Modrinth / CurseForge 両対応）。更新したもの、最新だった数、失敗を報告。プレリリースのみの更新は勝手に適用せず、配布ブロックされた CurseForge ファイルは試行せず報告する
- **cross_check_mods** — クロスソースの所持照合。Modrinth の見方（jar の sha1）と CurseForge の見方（packwiz .index）をプロジェクトのスラッグで突き合わせる。bothInstalled（別ファイル2本＝真の重複）、dualTracked（両ソースが認識する1ファイル）、availableOnBoth（片方から導入済みでもう片方にも存在）、片方のみ、特定不能 jar を報告。副産物として slug ⇔ 両プロジェクトIDの対応を `<dataDir>/prismlauncher-mcp/crossrefs.json` にマージ保存し、フォーク版 Prism の検索画面のクロスソース導入済み表示がこれを読む
- **dedupe_mod** — cross_check_mods で bothInstalled と出た slug について、`keep` で指定しなかった側のコピーを除去（jar＋packwiz 索引、jar は事前バックアップ）。破壊的操作のため confirm: true 必須。dualTracked（ファイルが1本だけ）の slug は拒否する
  引数: `instance` (string, required)
  引数: `instance` (string, required), `file` (string, required)

### Mod - CurseForge

- **search_mods_cf** — CurseForgeでmod検索
  引数: `query` (string, required), `gameVersion` (string), `loader` (string), `pageSize` (number)
- **list_mod_files_cf** — CurseForgeのファイル一覧（自動選択の候補も返す）
  引数: `modId` (number, required), `instanceId` (string)
- **install_mod_cf** — CurseForgeから導入（blockedファイルは報告され手動DL待ちになる）
  引数: `instanceId` (string, required), `modId` (number, required), `fileId` (number)
- **list_blocked_mods** — blocked記録の一覧
  引数: `instanceId` (string, required)
- **resolve_blocked_mods** — 手動DLされたファイルをsha1照合して配置
  引数: `instanceId` (string, required), `folder` (string, required)
- **check_mod_updates_cf** — CurseForge導入分の更新チェック
  引数: `instanceId` (string, required)
- **update_mod_cf** — CurseForge導入分の更新適用（旧jarはバックアップして除去）
  引数: `instanceId` (string, required), `mod` (string, required)

### Modpack

- **import_modpack** — .mrpackの取り込み（インスタンス生成＋sha1検証DL＋overrides展開）
- **install_modpack** — Modrinth のプロジェクトID/スラッグでパックを導入。ブリッジ有効な Prism が起動中ならアプリ自身が managed pack として導入し（後から Prism の更新チェック対象になる）、無ければ .mrpack をダウンロードしてファイルレベルで取り込む。任意 mod を含むパックはヘッドレスのブリッジでは拒否される（ダイアログが必要なため）。その場合はファイルレベルのフォールバックが処理する
  引数: `project` (string, required), `versionId` (string), `name` (string)
  引数: `path` (string, required), `name` (string)
- **import_modpack_cf** — CurseForge形式zipの取り込み（blocked方針は同じ）
  引数: `zipPath` (string, required), `name` (string)

### ワールドと設定ファイル

- **list_worlds** — ワールド一覧
  引数: `instance` (string, required)
- **get_world** — ワールド詳細（level.dat）
  引数: `instance` (string, required), `world` (string, required)
- **copy_world** — ワールドを別名でコピー（コピー側の session.lock は除去）
  引数: `instance` (string, required), `world` (string, required), `newName` (string, required)
- **backup_world** — ワールドをサーバの backups/worlds（データフォルダの prismlauncher-mcp 配下）へ zip 化し、パスを返す
  引数: `instance` (string, required), `world` (string, required)
- **get_options** — options.txtの参照
  引数: `instance` (string, required)
- **set_option** — options.txtの変更
  引数: `instance` (string, required), `key` (string, required), `value` (string, required)

### サーバ

- **list_servers** — servers.datのサーバ一覧
  引数: `instanceId` (string, required)
- **add_server** — servers.datへサーバ追加
  引数: `instanceId` (string, required), `name` (string, required), `ip` (string, required)
- **remove_server** — servers.datからサーバ削除（confirm必須）
  引数: `instanceId` (string, required), `name` (string), `ip` (string), `confirm` (boolean)

### ゲーム

- **bridge_status** — このデータフォルダでブリッジ有効な Prism（GUI または PrismLauncher-Agent ヘッドレス）が起動中かを確認します。利用可能な場合、起動/停止/作成/設定書き込みは起動中のアプリ経由になります。
  パラメータ: なし
- **launch_instance** — Prism経由で起動
  引数: `id` (string, required), `world` (string), `server` (string), `profile` (string), `offline` (string)
- **get_instance_status** — 起動状態の確認
  引数: `id` (string, required)
- **tail_log** — ゲームログの末尾取得
  引数: `id` (string, required), `lines` (number)
- **wait_for_event** — 起動完了等のイベント待ち
  引数: `id` (string, required), `pattern` (string, required), `timeoutMs` (number)
- **stop_instance** — ゲーム停止（confirm必須）
  引数: `id` (string, required), `confirm` (boolean)
- **list_screenshots** — スクリーンショット一覧
  引数: `id` (string, required)
- **get_screenshot** — スクリーンショット取得（画像で返る）
  引数: `id` (string, required), `file` (string, required)

### 翻訳（明示的な呼び出し専用）

- **extract_lang** — mod jarから言語ファイルを抽出（明示呼び出し専用）
  引数: `instanceId` (string), `modFile` (string), `jarPath` (string)
- **check_lang_consistency** — 翻訳の整合性チェック（キー欠落・プレースホルダ不一致等）
  引数: `slug` (string, required), `sourceLocale` (string), `targetLocale` (string)
- **build_lang_pack** — 翻訳から言語パックをビルドして導入（上書きはconfirm必須）
  引数: `slug` (string, required), `instanceId` (string, required), `packName` (string), `description` (string), `confirm` (boolean)

