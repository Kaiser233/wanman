# wanman

[English](README.md) | **中文** | [日本語](README.ja.md)

Agent Matrix 框架 —— 运行一个受监督的 Claude Code、Codex 或 Antigravity (`agy`) agent 网络，让它们在你的机器上协同工作。

wanman 是一个开源的本地模式 agent matrix 框架。它在你的机器上运行一个受监督的 Claude Code、Codex 或 Antigravity (`agy`) agent 网络，通过一个 JSON-RPC supervisor 进行协调。

## 关于 wanman

wanman 这个名字来自日语里的 [ワンマン电车 / one-man train](https://en.wikipedia.org/wiki/One-person_operation)：没有车掌、由一名司机独立运行的电车。wanman 的设计目标也取这个意象：让人类用户退居观察者角色，从全方位观察 agent matrix 自动运行。

[wanman.ai](https://wanman.ai/) 提供了 wanman 的全自动 24/7 沙箱版本，完全免费运行在 [Sandbank Cloud](https://cloud.sandbank.dev/) 沙箱云上。

## 它做什么

- 通过带 steer / follow-up 优先级的异步消息总线，协调多个 agent（CEO、dev、devops、marketing、feedback 等）。
- 将每个 agent 作为真实的 **Antigravity (`agy`)**（默认）、Claude Code 或 Codex CLI 子进程运行 —— 你自备 CLI 认证，wanman 负责编排生成、提示和生命周期。
- 支持 3 档抽象模型层级（`high` / `standard` / `fast`），自动映射到对应 runtime 的默认模型（如 `agy` 默认 `gemini-4-hydrogen-high` / `gemini-4-carbon-medium` / `gemini-3.8-flash-low`），支持 CLI 与环境变量覆盖。
- 为每个写码 worker（`dev`、`dev-*`、`devops`、`worker`、`worker-*`）分配独立的 git worktree 与分支（`agent/<name>`）及隔离的 `$HOME`，销毁动态 worker 时自动保留未合并或未提交的改动。
- 面向无人值守运行的硬熔断机制：全局 Token 上限（`--max-tokens`，默认 `1000000`）、单 Agent Token 上限（`--agent-max-tokens`）、全局墙钟时长上限（`--max-duration`，默认 `3600s`）、单次执行超时（`--spawn-timeout`，默认 `600s`），配合增强 TUI 进度条与结构化停机报告。
- 纯本地持久化：消息、上下文、任务、initiative、capsule 与 artifact 全部存储在单个本地 SQLite 数据库（`wanman.db`）中，零云端依赖。
- CLI 优先：一切都可通过 `wanman` 命令和 JSON-RPC supervisor 脚本化、可观测、可复现。

## 快速开始

```bash
# 前置条件：Node 20+、pnpm 9+、git，以及已登录的 Antigravity (agy)、Claude Code 或 Codex CLI。
git clone https://github.com/Kaiser233/wanman.git wanman
cd wanman
pnpm install
pnpm build

# 默认使用 Antigravity (agy) + 每 worker 独立 worktree 接管本地 git 仓库
pnpm --filter @wanman/cli exec wanman takeover /path/to/any/git/repo

# 可选：指定有限轮次 + Token / 时长硬熔断
pnpm --filter @wanman/cli exec wanman takeover /path/to/any/git/repo --loops 10 --max-tokens 500000 --max-duration 1800
```

如果你想生成一个单文件 CLI bundle：

```bash
pnpm --filter @wanman/cli standalone
node packages/cli/dist/wanman.mjs takeover /path/to/any/git/repo
```

如果 `wanman` 已经在你的 `PATH` 中，也可以在目标仓库内直接运行 `wanman takeover .`。

完整流程见 [`docs/quickstart.zh.md`](docs/quickstart.zh.md)。

## CLI 命令

| 命令 | 作用 |
|---------|--------------|
| `wanman send <agent> <msg>` | 向某个 agent 发送消息（`--steer` 会打断目标）。 |
| `wanman recv [--agent <name>]` | 接收并将待处理消息标记为已投递。 |
| `wanman agents` | 列出已注册的 agent 及其 runtime/model、当前工具、累计 Token、分支与状态。 |
| `wanman context get` / `context set` | 读写共享的 key/value 上下文。 |
| `wanman escalate <msg>` | 向 CEO agent 上报升级。 |
| `wanman task …` | 管理任务池：`create`、`list`、`get`、`update`、`done`。支持 `--after` 依赖。 |
| `wanman initiative …` | 管理长期 initiative：`create`、`list`、`get`、`update`。 |
| `wanman capsule …` | 管理变更 capsule：`create`、`list`、`mine`、`get`、`update`。 |
| `wanman artifact …` | 在本地 SQLite 中存储和检索结构化产物：`put`、`list`、`get`。 |
| `wanman watch` | 查看本地 `loop-events.ndjson` 事件与熔断记录。 |
| `wanman run <goal>` | 针对一次性目标启动 matrix，带增强 TUI 与熔断保护。 |
| `wanman takeover <path>` | 用每 worker 独立 git worktree 接管本地 git 仓库。 |
| `wanman skill:check [path]` | 校验 skill 文档只引用真实存在的 CLI 命令。 |

运行 `wanman --help` 获取完整的当前命令列表。

## 架构

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

- `wanman <subcommand>` 通过 JSON-RPC 2.0 与一个 Supervisor 进程通信。
- Supervisor 拥有 message store、context store、任务池、artifact store，并为每个 agent 派生一个子进程。
- 每个 agent 子进程都是一个本地的 Claude Code、Codex 或 Antigravity (`agy`) 子进程，绑定在独立的 worktree 和隔离的 `$HOME` 上。

深入阅读：[`docs/architecture.zh.md`](docs/architecture.zh.md)。

## 配置

| 环境变量 | 含义 |
|---------|---------|
| `WANMAN_URL` | CLI 使用的 Supervisor HTTP 地址（默认 `http://localhost:3120`）。 |
| `WANMAN_AGENT_NAME` | 标识当前 agent；在 agent 进程内作为默认发送者/接收者使用。 |
| `WANMAN_RUNTIME` | `agy`（默认；别名：`atg`、`antigravity`）、`claude` 或 `codex` —— 选择 per-agent CLI 适配器。 |
| `WANMAN_MODEL`、`WANMAN_CODEX_MODEL`、`WANMAN_CODEX_REASONING_EFFORT` | 通用及 Codex runtime 的模型与推理强度覆盖配置。 |
| `WANMAN_CODEX_FAST` | 设置后让 Codex 适配器偏向低延迟的默认值。 |
| `WANMAN_AGY_MODEL`、`WANMAN_AGY_HIGH_MODEL`、`WANMAN_AGY_STANDARD_MODEL`、`WANMAN_AGY_FAST_MODEL` | Antigravity (`agy`) 适配器的模型覆盖配置（设为 `default` 时省略 `--model`）。 |
| `WANMAN_AGY_EFFORT` | `agy` 的推理强度（`low`、`medium`、`high`、`xhigh`、`max`）。 |
| `WANMAN_AGY_BIN` | 覆盖 `agy` 可执行文件路径（回退到 `PATH` 和 `~/.local/bin/agy`）。 |
| `WANMAN_WORKTREE_ISOLATION` | 设为 `1` 开启每 worker 独立 git worktree（`agent/<name>`），`0` 为共享 worktree。 |
| `WANMAN_TOKEN_BUDGET` / `WANMAN_AGENT_TOKEN_BUDGET` | 全局（默认 `1000000`）与单 agent（默认 `0` 不限）Token 熔断预算。 |
| `WANMAN_MAX_DURATION_MS` / `WANMAN_TIME_BUDGET_MS` | 全局墙钟超时（默认 `3600000`）与单次 spawn 超时（默认 `600000`）。 |
| `WANMAN_SKILL_SNAPSHOTS_DIR` | 覆盖 runtime 物化 skill-activation 快照的目录（默认：shared-skills 目录的同级目录，回退到 `$TMPDIR/wanman-skill-snapshots`）。 |

全部状态（消息、context、任务、initiative、capsule 与 artifact）均持久化在本地 SQLite（`wanman.db`）中 —— 见 [`docs/architecture.zh.md`](docs/architecture.zh.md#10-本地持久化与熔断保护)。

## Agent 配置

Agent 定义集中在单个 JSON 文件中：

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

每条 agent 条目包含：
- `name` —— 消息总线上使用的唯一标识。
- `lifecycle` —— `24/7`（持续重生循环）、`on-demand`（空闲直到被触发），或 `idle_cached`（空闲直到被触发，通过 `claude --resume` 或 `agy --conversation` 保留上下文；`runtime: codex` 不支持 `idle_cached`）。
- `model` —— 通常使用抽象 tier（`high`、`standard` 或 `fast`）；runtime 适配器会映射到 Antigravity (`agy`)、Claude 或 Codex 的默认模型，也可以通过环境变量覆盖。
- `systemPrompt` —— 内置的角色设定/使命；agent 还会自动发现 `~/.claude/skills/`、`~/.codex/skills/` 和 `~/.gemini/config/skills/` 下的共享 skill 文件。
- 可选字段 `cron`、`events`、`tools` —— 完整 schema 见架构文档。

## 测试

```bash
pnpm typecheck
pnpm test
pnpm exec vitest run --coverage --coverage.reporter=text-summary --coverage.reporter=json-summary --coverage.exclude='**/dist/**'
```

当前覆盖率目标是行覆盖率至少 90%。最新一次本地验证结果为 `Lines: 90.17%`；机器可读的汇总会写入 `coverage/coverage-summary.json`。

## 项目结构

```
wanman.dev/
  packages/
    cli/                 wanman CLI (send/recv/task/artifact/run/takeover/...)
    core/                Shared types, JSON-RPC protocol, skills (core/skills/)
    host-sdk/            Host-side SDK for embedding wanman into other tools
    runtime/             Supervisor, agent process manager, SQLite stores, adapters
  docs/                  Architecture and quickstart guides
```

当前已内置的共享 skills（`packages/core/skills/`）：
- `artifact-naming`、`artifact-quality` —— agent 产出物的命名与质量规范。
- `cross-validation` —— CEO 对各 agent 产出进行一致性检查。
- `research-methodology` —— 市场/数据调研方法论。
- `wanman-cli` —— 供 agent 在运行时查阅的 CLI 命令参考。
- `workspace-conventions` —— agent 工作区内的文件系统约定。

## 延伸阅读

- [快速开始](docs/quickstart.zh.md) —— 针对任意 git 仓库的首次运行流程。
- [架构](docs/architecture.zh.md) —— agent 生命周期、JSON-RPC、存储、适配器。
- [贡献指南](CONTRIBUTING.zh.md) —— 测试、类型检查、提交约定。

## 许可证

Apache-2.0 —— 见 [LICENSE](LICENSE)。
