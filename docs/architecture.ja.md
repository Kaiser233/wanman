# Architecture

[English](architecture.md) | [中文](architecture.zh.md) | **日本語**

このドキュメントは wanman のコードベースに初めて触れる開発者が最初に読むべきツアーです。スーパーバイザーの構造、エージェントの spawn と相互通信の方法、そして状態がどこに存在するかを解説します。

## 1. システム概要

```
+----------------+              +--------------------------------+
|  wanman CLI    |              |  Supervisor process (local)    |
|  (host shell)  |  JSON-RPC    |                                |
|                | -----------> |  MessageStore  ContextStore    |
|  send/recv/    |  HTTP :3120  |  TaskPool      ArtifactStore   |
|  task/agents/  |              |  InitiativeBoard               |
|  artifact/...  |              |  CronScheduler                 |
+----------------+              |  Relay         LoopEventBus    |
                                |                                |
                                |  +--------------------------+  |
                                |  |  AgentProcess[]          |  |
                                |  |  (spawns Claude/Codex/   |  |
                                |  |   Agy CLI children)      |  |
                                |  +--------------------------+  |
                                +----------------+---------------+
                                                 |
                                                 v
                                    Claude / Codex / Agy subprocess
                                    (per-agent worktree + $HOME)
```

CLI は薄い JSON-RPC 2.0 クライアントです。興味深いもの — プロセス管理、永続化、ルーティング — はすべてスーパーバイザーに存在します。スーパーバイザーは素のローカル Node.js プロセスであり、CLI はそれに到達するために `WANMAN_URL` のみを必要とします。

## 2. エージェントのライフサイクル

各エージェントは agents 設定で `lifecycle` を宣言しています:

### 2.1 `24/7` — 連続再生成

```
start()
  +-> runLoop()
        +- relay.recv()            -- pull pending messages
        +- spawnAgent()            -- boot the CLI subprocess with those as prompt
        +- wait()                  -- block until the subprocess exits
        +- sleep(RESPAWN_DELAY_MS) -- cooldown
        +- repeat
```

- ループ反復ごとに 1 つの新しい CLI サブプロセスを spawn します。
- 保留メッセージがあればそれが初期プロンプトになります。なければ「あなたは起動中、受信箱を確認してください」という既定プロンプトが使われます。
- 終了 → cooldown → 再生成。このループは `handleSteer()` によって中断されます（後述）。

### 2.2 `on-demand` — トリガーまでアイドル

```
start()
  +-> state = 'idle'   (no CLI subprocess running)
        +- trigger() or handleSteer()
             +- relay.recv()
             +- spawnAgent()
             +- wait()
        +- state = 'idle' again
```

- 初期状態は `idle` で、何かがつつくまで CPU は消費しません。
- steer 優先度のメッセージや cron tick が単一実行をトリガーし、完了後は `idle` に戻ります。

### 2.3 `idle_cached` — コンテキストを引き継ぐアイドル実行（Claude / Agy）

- `on-demand` と同じく待機中は CPU を消費しませんが、次回起動時に捕捉済みセッション ID を `claude --resume <id>` または `agy --conversation <id>` で渡して会話コンテキストを引き継ぎます（`runtime: codex` は非対応）。

### 2.4 エージェントの状態

| State | 意味 |
|-------|---------|
| `idle` | 待機中（on-demand の通常状態）。 |
| `running` | Claude Code、Codex、または Antigravity (`agy`) サブプロセスが実行中です。 |
| `stopped` | 手動停止、または終了処理中です。 |
| `error` | 直近でクラッシュ。スーパーバイザーがリトライします。 |

## 3. メッセージシステム

### 3.1 優先度

| Priority | Value | Effect |
|----------|-------|--------|
| `steer` | 0 | 対象の現在のサブプロセスを**中断**します。次のループ反復で最優先処理されます。 |
| `followUp` | 1 | 通常のキューイング。次のループでタイムスタンプ順に処理されます。 |

### 3.2 steer の仕組み

```
sender                        Relay                         target agent
  |                             |                               |
  |-- agent.send(steer) ------->|                               |
  |                             |-- messageStore.enqueue() -----|
  |                             |-- steerCallback(agent) ------>|
  |                             |                               |-- kill(currentProcess)
  |                             |                               |
  |                             |                 (next loop)   |
  |                             |                               |-- relay.recv()
  |                             |                               |   (steer sorted first)
  |                             |                               |-- spawnAgent(steerMsg)
```

relay の steer コールバックは `AgentProcess` に現在の Claude/Codex 子プロセスを SIGKILL するよう指示します。ランループ通常の再生成パスは、SQL の並び順のおかげで steer メッセージを最初に拾い上げます。

### 3.3 配信保証

- メッセージは `send()` が return する前に SQLite（`messages` テーブル）に永続化されます。
- `recv()` は保留行（`delivered = 0`）を返し、*同一トランザクション*でそれらを配信済みとしてマークします — 二重配信はありません。
- 並び順: `ORDER BY CASE priority WHEN 'steer' THEN 0 ELSE 1 END, timestamp ASC`。

### 3.4 メッセージの形

```ts
interface AgentMessage {
  id: string              // UUID
  from: string            // sender agent name (or "system")
  to: string              // recipient agent name
  priority: 'steer' | 'followUp'
  content: string         // plain text prompt body
  timestamp: number       // unix ms
  delivered: boolean
}
```

## 4. Context store

SQLite 上の、エージェント間で共有される key/value ストレージです。「直近のビルド結果」や「現在の MRR」など、システム全体の状態に有用です。

```ts
interface ContextEntry {
  key: string
  value: string
  updatedBy: string  // agent name
  updatedAt: number  // unix ms
}
```

RPC メソッド: `context.get`、`context.set`、`context.list`。`set` は upsert（`INSERT ... ON CONFLICT DO UPDATE`）です。

## 5. Task pool、initiatives、artifacts、capsules

スーパーバイザーは生メッセージを超えた構造化された状態も保有します:

- **TaskPool** — エージェントが所有する task。状態（`pending`、`in_progress`、`done`、`blocked`）、優先度、`--after` 依存関係を持ちます。`wanman task list` は依存関係を考慮したビューを描画します。
- **InitiativeBoard** — 長期にわたる複数タスクから成る initiative。
- **ArtifactStore** — `wanman artifact put` でローカル SQLite に保存される構造化出力（調査サマリ、計画など）です。Artifact は kind、path、content、JSON メタデータを持ちます。
- **ChangeCapsulePool** — エージェントがレビュー可能な、提案された変更バンドルです。

これらはすべて単一のローカル `wanman.db` 配下の SQLite テーブルであり、JSON-RPC 経由でアクセスできます。

## 6. 外部イベントと cron

エージェント間メッセージ以外に、matrix への非同期入力は 2 つあります:

- **`POST /events`** — 外部システム（CI、webhook、人間のスクリプト）が `ExternalEvent` オブジェクトを push します。スーパーバイザーはエージェントを走査し、`definition.events[]` にそのイベントタイプを含むものに対して、シリアライズされたペイロードを持つ follow-up メッセージをキューイングします。
- **CronScheduler** — 60 秒ごとに実行され、各エージェントの `cron` 式をチェックし、マッチしたら follow-up メッセージを発火します（on-demand エージェントには `handleSteer()` も併せて）。標準的な 5 フィールド cron: `min hour dom mon dow`。

これらが、特定の webhook プロバイダをハードコードすることなく、wanman を「残りのインフラ」に繋ぐ 2 つの接続面です。

## 7. Runtime アダプタ

各エージェントの子プロセスは Claude Code、Codex、または Antigravity (`agy`) サブプロセスです。スーパーバイザーは `WANMAN_RUNTIME`（デフォルト `claude`、`codex`、または `agy`〔エイリアス: `atg`、`antigravity`〕）およびエージェントごとの上書きを介して選択します。

- `claude-adapter.ts` / `claude-code.ts` — エージェントのシステムプロンプトとともに `claude` を spawn し、skill ファイルを注入し、構造化イベントをスーパーバイザーにストリーミングします。
- `codex-adapter.ts` — 同じ形状で `@openai/codex` を対象とします。`WANMAN_CODEX_MODEL` と `WANMAN_CODEX_REASONING_EFFORT` でモデル選択を制御します。
- `agy-adapter.ts` — Antigravity CLI（`agy --input-format stream-json --output-format stream-json --dangerously-skip-permissions`）を対象とし、`WANMAN_AGY_BIN`、`PATH`、`~/.local/bin/agy` の順でバイナリを解決します。`WANMAN_AGY_MODEL`、`WANMAN_AGY_HIGH_MODEL`、`WANMAN_AGY_STANDARD_MODEL`、`WANMAN_AGY_EFFORT` でモデル・推論強度を制御し、`AGY_CLI_DISABLE_AUTO_UPDATE=true` と `AGY_CLI_HIDE_LOGO=true` を自動設定します。

すべてのアダプタが同一の `AgentRunEvent` ストリームを発行するため、スーパーバイザーと CLI はどちらが動いているかを気にしません。新しいアダプタの追加は、そのイベント契約を実装し `agent-adapter.ts` / `agent-process.ts` に登録するだけです。

## 8. ワークツリーと home の隔離

最初の子を spawn する前に、スーパーバイザーはエージェントごとに以下を準備します:

- `.wanman/worktree/` 配下に現在の `HEAD` から展開した**ワークツリー**。エージェントはあなたの実際のチェックアウトではなくこれを編集します。
- `.wanman/home/<agent>/` 配下の**エージェントごとの `$HOME`**。生成された `wanman` と `pnpm` ラッパーを備えます。シェルプロファイルへの書き込みや `.npmrc` の編集などはすべてこの中に封じ込められます。
- その home 配下の**エージェントごとの認証・状態ディレクトリ**: `.claude/` と `.codex/` はエージェントごとに分離し、`.gemini/` は選択的にブリッジします（存在すれば `GEMINI.md`、`antigravity-cli/settings.json`、`antigravity-cli/keybindings.json`、`config/{config.json,mcp_config.json,hooks.json,plugins,agents}` をシンボリックリンクし、macOS では `Library/Keychains` もリンクしつつ、`antigravity-cli` の実行状態 `conversations/`・`brain/`・`cache/` と `config/skills/` はエージェント/ランごとに隔離します）。

各エージェントの `$PATH` 内の `wanman` ラッパーは同じ CLI バイナリを指しますが、事前に `WANMAN_AGENT_NAME` をセットしています。そのためエージェントから見ると、引数なしの `wanman recv` が「そのまま動く」ようになっています。

## 9. Shared skills

`packages/core/skills/*/SKILL.md` は runtime バンドルと一緒に配布されます。スーパーバイザー起動時、共有 skill は各エージェントの `~/.claude/skills/`、`~/.codex/skills/`、`~/.gemini/config/skills/` に展開され、Claude Code、Codex、Antigravity (`agy`) から自動検出されます。

Skill スナップショット — 特定のランに紐付けられた不変コピー — は、`WANMAN_SKILL_SNAPSHOTS_DIR` で解決されるディレクトリ、または shared-skills ディレクトリの兄弟、あるいは最後の手段として `$TMPDIR/wanman-skill-snapshots` に書き出されます。これが、所与のタスクでエージェントが利用できた skill のバージョンを正確に監査できる仕組みです。

現在同梱されている skill:
- `artifact-naming`, `artifact-quality` — エージェントが生成する artifact の規約です。
- `cross-validation` — CEO によるエージェント出力の整合性チェックです。
- `research-methodology` — マーケット/データ調査の方法論です。
- `wanman-cli` — エージェントが実行時に参照する CLI コマンドリファレンスです。
- `workspace-conventions` — エージェントがワークスペース内で従うべきファイル配置です。

## 10. ローカル永続化とサーキットブレーカー

- **ローカル SQLite（agents 設定の `dbPath`）** — クラウド依存なしで常に有効です。messages、context、tasks、initiatives、capsules、artifacts（`ArtifactStore`）を同一ワークスペース内で永続化します。
- **ハードサーキットブレーカー** — 全体・エージェント単位のトークン上限（`tokenBudget` / `agentTokenBudget`）、全体実行時間上限（`maxDurationMs`）、単発タイムアウト（`spawnTimeoutMs`）をリアルタイム監視し、超過時はエージェントを停止して `run.halted` と `/health.budget.halted` を記録します。

## 11. HTTP サーフェスの概観

| Endpoint | Method | 用途 |
|----------|--------|---------|
| `/health` | GET | スーパーバイザー、エージェント詳細、`budget`、`worktrees` スナップショット。 |
| `/rpc` | POST | JSON-RPC 2.0 — CLI のメインサーフェス。 |
| `/events` | POST | 外部イベントのイングレス。 |

主要な RPC メソッド:

| Method | 用途 |
|--------|---------|
| `agent.send` / `agent.recv` / `agent.list` | エージェント間メッセージングと状態取得。 |
| `context.get` / `context.set` / `context.list` | 共有 context。 |
| `task.*` / `initiative.*` / `capsule.*` / `artifact.*` | ローカル SQLite の構造化状態。 |
| `event.push` | `POST /events` と同等。RPC クライアント向け。 |
| `health.check` | RPC 経由のヘルススナップショット。 |

エラーは標準的な JSON-RPC コード（`-32700` parse、`-32600` invalid request、`-32601` method not found、`-32602` invalid params、`-32603` internal）に加え、`-32000`（agent not found）と `-32001`（agent not running）を使います。

## 12. コードの所在

```
packages/
  cli/         Commands (send, recv, task, artifact, run, takeover, watch).
               Speaks JSON-RPC to the supervisor. No business logic.
  core/        Shared types and JSON-RPC protocol definitions.
               core/skills/ ships the SKILL.md bundle.
  host-sdk/    Programmatic embedding SDK for host-side integrations.
  runtime/     The supervisor. Agent process manager, SQLite stores,
               Claude/Codex/Agy adapters, cron scheduler, event router.
```

CLI サーフェスおよび環境変数については [README](../README.ja.md#cli-コマンド) を参照してください。
