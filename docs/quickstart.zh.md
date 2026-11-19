# 快速开始

[English](quickstart.md) | **中文** | [日本語](quickstart.ja.md)

本文带你完整走一遍：在你机器上任意一个 git 仓库上首次运行 wanman。

## 1. 前置条件

- **Node.js 20+** 和 **pnpm 9+**（`corepack enable && corepack prepare pnpm@9.15.0 --activate`）。
- **git**。
- 已认证的 Claude Code、Codex *或* Antigravity (`agy`) CLI —— wanman 会把它们当成 agent 子进程来派生，并直接复用宿主机已有的认证。
  - Claude Code：全局安装 `@anthropic-ai/claude-code` 并运行登录流程（执行 `claude` 然后按提示操作）。
  - Codex：全局安装 `@openai/codex`，按 Codex CLI 文档完成登录。
  - Antigravity (`agy`)：安装 `agy`（位于 `PATH`、`~/.local/bin/agy`，或通过 `WANMAN_AGY_BIN` 指定）并完成认证：在宿主机交互登录（写入 macOS 钥匙串凭证，如 service `gemini` / account `antigravity`）、设置 `AGY_ADC_AUTH=true`，或在 `~/.gemini/antigravity-cli/settings.json` 中配置 `"modelProvider": "gemini"` 并设置 `GEMINI_API_KEY`。
- **任意现有的 git 仓库**，你愿意让 agent 在里面读取和修改。wanman 会为每个写码 worker 创建独立的 git worktree（`.wanman/worktrees/<worker>`，分支 `agent/<worker>`），从不会修改你未提交的工作区。

## 2. Clone、安装、构建

```bash
git clone https://github.com/Kaiser233/wanman.git wanman
cd wanman
pnpm install
pnpm build
```

`pnpm build` 会在 `packages/cli/dist/index.js` 产出一个独立的 CLI bundle。你可以把它加入 `PATH`，或者在开发中直接用 `pnpm --filter @wanman/cli exec wanman ...`。

本地迭代时可以用 `npm link` 链接该 CLI：

```bash
cd packages/cli
npm link
wanman --help
```

## 3. 接管一个 git 仓库

在任意现有 git 项目的根目录下：

```bash
cd /path/to/any/git/repo
wanman takeover .
```

过程如下：
1. wanman 在仓库内创建 `.wanman/` 来保存本地状态。
2. 它从当前 `HEAD` 物化出 `.wanman/worktree/`，并默认在 `.wanman/worktrees/<worker>` 下为每个写码 worker（`dev`、`dev-*`、`devops`）创建独立分支 `agent/<worker>`。
3. 它在自动挑选的 `127.0.0.1` 端口上启动一个 supervisor，并等待健康检查通过。
4. 它在一个隔离的 `.wanman/home/` 下派生 agent（默认使用 Antigravity `agy` 子进程），让 shell 配置文件的改动不会污染你真实的 `$HOME`。
5. takeover 实时渲染增强 TUI 仪表盘（展示 runtime/model、当前工具、Token 预算进度条、时长上限与分支状态）；当触发 Token 或时长熔断时自动停止所有 agent 并输出结构化停机报告。

可通过参数选择 runtime、有限轮次或硬熔断预算：

```bash
wanman takeover .                                        # 默认：agy + 独立 worktree
wanman takeover . --agy-model gemini-3.8-flash-low --agy-speed fast
wanman takeover . --loops 10 --max-tokens 500000 --max-duration 1800
wanman takeover . --runtime claude
wanman takeover . --runtime codex
wanman takeover . --no-worktree-isolation                # 共享单一 worktree
```

## 4. 与 matrix 对话

在第二个终端中（同样的 shell，这样如果设置了 `WANMAN_URL` 会继承，否则使用默认的 `http://localhost:3120`）：

```bash
wanman agents                              # list registered agents and their states
wanman send ceo "Build me a sample TODO API"
wanman watch                               # live-stream supervisor events
```

`send` 会在 CEO 的收件箱里放入一条 follow-up 消息。如果你想打断 agent 当前的工作，使用 `--steer`：

```bash
wanman send ceo --steer "Stop — focus on the API, not the landing page"
```

读取回复（并标记为已投递）：

```bash
wanman recv --agent ceo
```

## 5. 查看 artifact

Agent 通过 `wanman artifact put` 产出结构化的 artifact —— 调研摘要、计划、财务模型等。浏览它们：

```bash
wanman artifact list                # newest first, all agents
wanman artifact list --agent ceo    # filter by producer
wanman artifact get <id>            # full content + metadata
```

Artifact 的命名和质量规范在 [`packages/core/skills/artifact-naming/SKILL.md`](../packages/core/skills/artifact-naming/SKILL.md) 和 [`artifact-quality/SKILL.md`](../packages/core/skills/artifact-quality/SKILL.md)。

你也可以用类似方式查看 task 和 initiative：

```bash
wanman task list
wanman task get <task-id>
wanman initiative list
```

## 6. 清理

wanman 为一次 takeover 所创建的一切都放在目标仓库内的 `.wanman/` 下：

```
.wanman/
  worktree/   clean checkout the agents actually edit
  home/       isolated $HOME for agent subprocesses
  agents/     per-agent workspace dirs (output, scratch)
  wanman.db   SQLite store: messages, context, tasks, artifacts, ...
  logs/       supervisor and agent logs
```

要重置某个仓库的状态，停止 `wanman takeover`（Ctrl+C），然后：

```bash
rm -rf .wanman
```

你真实的工作区毫发无损 —— wanman 只在 `.wanman/` 里写过东西。

## 7. 接下来去哪里

- 想理解 JSON-RPC 协议、消息优先级和 agent 生命周期？见 [architecture.zh.md](architecture.zh.md)。
- 想贡献代码？见 [CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md)。
