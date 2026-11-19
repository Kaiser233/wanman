# wanman

[English](README.md) | [中文](README.zh.md) | **日本語**

Agent Matrix フレームワーク — 監督下の Claude Code、Codex、または Antigravity (`agy`) エージェントのネットワークを起動し、あなたのマシン上で協調動作させます。

wanman はオープンソースのローカルモード Agent Matrix フレームワークです。監督下の Claude Code、Codex、または Antigravity (`agy`) エージェントのネットワークをあなたのマシン上で動かし、JSON-RPC スーパーバイザーを介して協調動作させます。

## wanman について

wanman という名前は、日本語の [ワンマン電車 / one-man train](https://en.wikipedia.org/wiki/One-person_operation) に由来します。車掌なしで 1 人の運転士が運行する電車です。wanman の設計目標もこのイメージに近く、人間のユーザーが観察者の役割に退き、agent matrix が自動実行される様子を全方位から観察できるようにすることです。

[wanman.ai](https://wanman.ai/) は、wanman の完全自動 24/7 サンドボックス版を提供しています。これは [Sandbank Cloud](https://cloud.sandbank.dev/) のサンドボックスクラウド上で完全無料で動作します。

## 何をするか

- 複数のエージェント（CEO、dev、devops、marketing、feedback など）を、steer/follow-up 優先度付きの非同期メッセージバスで連携させます。
- 各エージェントを実際の **Antigravity (`agy`)**（デフォルト）、Claude Code、または Codex CLI サブプロセスとして実行します。CLI 認証はあなた自身のものを利用し、wanman は spawn、プロンプト送出、ライフサイクルを統括します。
- 3 段階の抽象モデル tier（`high` / `standard` / `fast`）をサポートし、各 runtime のデフォルトへ解決します。
- コード編集 worker（`dev`、`dev-*`、`devops`、`worker`、`worker-*`）ごとに独立した git ワークツリーとブランチ（`agent/<name>`）および隔離された `$HOME` を割り当て、未マージの変更を自動保護します。
- 無人実行向けのハードサーキットブレーカー（`--max-tokens`、`--agent-max-tokens`、`--max-duration`、`--spawn-timeout`）と拡張 TUI・構造化レポートを備えています。
- 純ローカル永続化：すべての状態（messages、context、tasks、initiatives、capsules、artifacts）を単一のローカル SQLite（`wanman.db`）に保存し、クラウド依存を排除しています。
- CLI ファーストです。すべてが `wanman` コマンドと JSON-RPC スーパーバイザー経由でスクリプト化可能、観測可能、再現可能です。

## Quickstart

```bash
# 前提条件: Node 20+, pnpm 9+, git, 認証済みの Antigravity (agy)、Claude Code、または Codex CLI。
git clone https://github.com/Kaiser233/wanman.git wanman
cd wanman
pnpm install
pnpm build

# ソースから直接実行します（デフォルト: agy + worker ごとの隔離 worktree）。
pnpm --filter @wanman/cli exec wanman takeover /path/to/any/git/repo
```

単一ファイルの CLI bundle が必要な場合:

```bash
pnpm --filter @wanman/cli standalone
node packages/cli/dist/wanman.mjs takeover /path/to/any/git/repo
```

`wanman` がすでに `PATH` にある場合は、対象リポジトリ内で `wanman takeover .` を直接実行できます。

完全な手順は [`docs/quickstart.ja.md`](docs/quickstart.ja.md) を参照してください。

## CLI コマンド

| コマンド | 用途 |
|---------|--------------|
| `wanman send <agent> <msg>` | エージェントにメッセージを送信します（`--steer` は対象を中断します）。 |
| `wanman recv [--agent <name>]` | 保留中のメッセージを受信し、配信済みとしてマークします。 |
| `wanman agents` | 登録済みエージェントと現在の状態を一覧表示します。 |
| `wanman context get` / `context set` | 共有の key/value コンテキストを読み書きします。 |
| `wanman escalate <msg>` | CEO エージェントにエスカレーションします。 |
| `wanman task …` | タスクプールを管理します: `create`、`list`、`get`、`update`、`done`。`--after` による依存関係もサポートします。 |
| `wanman initiative …` | 長期的な initiative を管理します: `create`、`list`、`get`、`update`。 |
| `wanman capsule …` | 変更 capsule を管理します: `create`、`list`、`mine`、`get`、`update`。 |
| `wanman artifact …` | 構造化された artifact をローカル SQLite に保存・取得します: `put`、`list`、`get`。 |
| `wanman watch` | ローカルの `loop-events.ndjson` ログとサーキットブレーカーイベントを確認します。 |
| `wanman run <goal>` | 単発ゴールに対して matrix を起動します。 |
| `wanman takeover <path>` | 既存の git リポジトリを完全な agent matrix で引き継ぎます。 |
| `wanman skill:check [path]` | skill ドキュメントが実在の CLI コマンドのみを参照しているか検証します。 |

最新の完全なリストは `wanman --help` を実行して確認してください。

## アーキテクチャ

```
+----------------+          +--------------------+          +-----------------+
|  wanman CLI    |  JSON    |  Supervisor        |  spawn   |  Agent process  |
|  (host shell)  | ---RPC-->|  (local process)   | -------> | (Claude/Codex/Agy)|
|                |  /rpc    |  message/context/  |          |  per-agent $HOME|
|                |          |  task/artifact     |          |  per-agent wt   |
+----------------+          +--------------------+          +-----------------+
                                    |                              |
                                    v                              v
                           +--------------------+        +-----------------+
                           |  files + SQLite    |        |  worktree       |
                           +--------------------+        +-----------------+
```

- `wanman <subcommand>` は Supervisor プロセスに対して JSON-RPC 2.0 で通信します。
- Supervisor は message store、context store、task pool、artifact store を保有し、エージェントごとに 1 つの子プロセスを spawn します。
- 各エージェントの子プロセスはローカルの Claude Code、Codex、または Antigravity (`agy`) サブプロセスで、エージェントごとのワークツリーと隔離された `$HOME` に紐付いています。

詳細: [`docs/architecture.ja.md`](docs/architecture.ja.md)。

## 設定

| 環境変数 | 意味 |
|---------|---------|
| `WANMAN_URL` | CLI 向けの Supervisor HTTP URL（デフォルト `http://localhost:3120`）。 |
| `WANMAN_AGENT_NAME` | 現在のエージェントを識別します。エージェントプロセス内で既定の送信者/受信者として使われます。 |
| `WANMAN_RUNTIME` | `agy`（デフォルト; エイリアス: `atg`、`antigravity`）、`claude`、または `codex` — エージェントごとの CLI アダプタを選択します。 |
| `WANMAN_MODEL`, `WANMAN_CODEX_MODEL`, `WANMAN_CODEX_REASONING_EFFORT` | 共通および Codex runtime のモデル・推論強度の上書き設定です。 |
| `WANMAN_CODEX_FAST` | 設定すると Codex アダプタを低レイテンシ寄りのデフォルトに傾けます。 |
| `WANMAN_AGY_MODEL`, `WANMAN_AGY_HIGH_MODEL`, `WANMAN_AGY_STANDARD_MODEL`, `WANMAN_AGY_FAST_MODEL` | Antigravity (`agy`) アダプタのモデル上書き設定です（`default` 指定で `--model` を省略）。 |
| `WANMAN_AGY_EFFORT` | `agy` の推論強度（`low`、`medium`、`high`、`xhigh`、`max`）。 |
| `WANMAN_AGY_BIN` | `agy` バイナリパスを上書きします（既定は `PATH` および `~/.local/bin/agy`）。 |
| `WANMAN_WORKTREE_ISOLATION` | `1` で worker ごとの独立ワークツリー（`agent/<name>`）を有効化、`0` で共有ワークツリー。 |
| `WANMAN_TOKEN_BUDGET` / `WANMAN_AGENT_TOKEN_BUDGET` | 全体（既定 `1000000`）およびエージェント単位（既定 `0` 無制限）のトークン上限。 |
| `WANMAN_MAX_DURATION_MS` / `WANMAN_TIME_BUDGET_MS` | 全体実行時間上限（既定 `3600000`）と 1 スポーンタイムアウト（既定 `600000`）。 |
| `WANMAN_SKILL_SNAPSHOTS_DIR` | runtime が skill 有効化スナップショットを展開する場所を上書きします（デフォルトは shared-skills ディレクトリの兄弟、フォールバックは `$TMPDIR/wanman-skill-snapshots`）。 |

すべての状態はローカル SQLite（`wanman.db`）に永続化されます — [`docs/architecture.ja.md`](docs/architecture.ja.md) を参照してください。

## エージェント設定

エージェントの定義は単一の JSON ファイルに記述します:

```json
{
  "agents": [
    { "name": "echo", "lifecycle": "24/7", "model": "standard", "systemPrompt": "..." },
    { "name": "ping", "lifecycle": "on-demand", "model": "standard", "systemPrompt": "..." }
  ],
  "dbPath": ".wanman/wanman.db",
  "port": 3120,
  "workspaceRoot": ".wanman/agents"
}
```

エージェントエントリごとに以下のフィールドがあります:
- `name` — メッセージバス上で使われる一意識別子です。
- `lifecycle` — `24/7`（連続再生成ループ）、`on-demand`（トリガーがあるまでアイドル）、または `idle_cached`（トリガーがあるまでアイドルし、`claude --resume` や `agy --conversation` でコンテキストを引き継ぐ。`runtime: codex` では不可）。
- `model` — 通常は抽象 tier（`high` または `standard`）を使います。runtime アダプタが Claude、Codex、または Antigravity (`agy`) のデフォルトモデルに解決し、環境変数で上書きできます。
- `systemPrompt` — 組み込みのペルソナ/ミッションです。エージェントは `~/.claude/skills/`、`~/.codex/skills/`、`~/.gemini/config/skills/` にある共有 skill ファイルも自動検出します。
- オプションの `cron`、`events`、`tools` フィールド — 完全なスキーマは architecture ドキュメントを参照してください。

## Testing

```bash
pnpm typecheck
pnpm test
pnpm exec vitest run --coverage --coverage.reporter=text-summary --coverage.reporter=json-summary --coverage.exclude='**/dist/**'
```

現在のカバレッジ目標は、行カバレッジ 90% 以上です。直近のローカル検証では `Lines: 90.17%` でした。機械可読のサマリーは `coverage/coverage-summary.json` に出力されます。

## プロジェクト構造

```
wanman.dev/
  packages/
    cli/                 wanman CLI (send/recv/task/artifact/run/takeover/...)
    core/                Shared types, JSON-RPC protocol, skills (core/skills/)
    host-sdk/            Host-side SDK for embedding wanman into other tools
    runtime/             Supervisor, agent process manager, SQLite stores, adapters
  docs/                  Architecture and quickstart guides
```

現在同梱されている共有 skill（`packages/core/skills/`）:
- `artifact-naming`, `artifact-quality` — エージェントが生成する artifact の規約です。
- `cross-validation` — CEO によるエージェント出力の整合性チェックです。
- `research-methodology` — マーケット/データ調査の方法論です。
- `wanman-cli` — エージェントが実行時に参照する CLI コマンドリファレンスです。
- `workspace-conventions` — エージェントワークスペース内のファイルシステム規約です。

## 参考資料

- [Quickstart](docs/quickstart.ja.md) — 任意の git リポジトリに対する初回実行ウォークスルーです。
- [Architecture](docs/architecture.ja.md) — エージェントのライフサイクル、JSON-RPC、ストア、アダプタについて。
- [Contributing](CONTRIBUTING.ja.md) — テスト、typecheck、コミット規約について。

## ライセンス

Apache-2.0 — [LICENSE](LICENSE) を参照してください。
