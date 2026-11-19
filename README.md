# wanman

**English** | [中文](README.zh.md) | [日本語](README.ja.md)

Agent Matrix framework — run a supervised network of Claude Code, Codex, or Antigravity (`agy`) agents that collaborate on your machine.

wanman is an open-source local-mode agent matrix framework. Runs a supervised network of Claude Code, Codex, or Antigravity (`agy`) agents on your machine, coordinated through a JSON-RPC supervisor.

## About wanman

The name wanman comes from the Japanese [ワンマン電車 / one-man train](https://en.wikipedia.org/wiki/One-person_operation): a train operated by one driver without a conductor. wanman's design goal is similar in spirit: the human user steps back into an observer role and watches the agent matrix run automatically from every angle.

[wanman.ai](https://wanman.ai/) provides the fully automated 24/7 sandbox edition of wanman, running for free on [Sandbank Cloud](https://cloud.sandbank.dev/)'s sandbox cloud.

## What it does

- Coordinates multiple agents (CEO, dev, devops, marketing, feedback, etc.) through an async message bus with steer/follow-up priorities.
- Runs each agent as a real **Antigravity (`agy`)** (default), Claude Code, or Codex CLI subprocess — you bring your own CLI auth, wanman orchestrates spawning, prompting, and lifecycle.
- Supports 3 abstract model tiers (`high`, `standard`, `fast`) mapped per runtime (e.g. `agy`: `gemini-4-hydrogen-high` / `gemini-4-carbon-medium` / `gemini-3.8-flash-low`) with CLI & env overrides.
- Isolates every code-writing worker (`dev`, `dev-*`, `devops`, `worker`, `worker-*`) in its own git worktree and branch (`agent/<name>`) under `.wanman/worktrees/` plus an isolated `$HOME`, preserving unmerged/dirty work automatically.
- Protects unattended runs with hard circuit breakers: global token budget (`--max-tokens`, default `1000000`), per-agent token budget (`--agent-max-tokens`), wall-clock duration cap (`--max-duration`, default `3600s`), per-spawn timeout (`--spawn-timeout`, default `600s`), live TUI progress bars, and a structured stop/halt report.
- Pure-local persistence: messages, context, tasks, initiatives, capsules, and artifacts live in a single local SQLite database (`wanman.db`) with zero cloud dependencies.
- Is CLI-first: everything is scriptable, observable, and reproducible through `wanman` commands and a JSON-RPC supervisor.

## Quickstart

```bash
# Prerequisites: Node 20+, pnpm 9+, git, and an authenticated Antigravity (agy), Claude Code, or Codex CLI.
git clone https://github.com/Kaiser233/wanman.git wanman
cd wanman
pnpm install
pnpm build

# Take over any local git repo with Antigravity (agy) + isolated per-worker worktrees (default)
pnpm --filter @wanman/cli exec wanman takeover /path/to/any/git/repo

# Optional: finite loops + explicit token/duration circuit breakers
pnpm --filter @wanman/cli exec wanman takeover /path/to/any/git/repo --loops 10 --max-tokens 500000 --max-duration 1800
```

If you want a single-file CLI bundle instead:

```bash
pnpm --filter @wanman/cli standalone
node packages/cli/dist/wanman.mjs takeover /path/to/any/git/repo
```

If `wanman` is already on your `PATH`, you can also run `wanman takeover .` from inside the target repository.

See [`docs/quickstart.md`](docs/quickstart.md) for the full walkthrough.

## CLI commands

| Command | What it does |
|---------|--------------|
| `wanman send <agent> <msg>` | Send a message to an agent (`--steer` interrupts the target). |
| `wanman recv [--agent <name>]` | Receive and mark pending messages as delivered. |
| `wanman agents` | List registered agents with runtime/model, active tool, tokens, branch, and state. |
| `wanman context get` / `context set` | Read or write shared key/value context. |
| `wanman escalate <msg>` | Escalate to the CEO agent. |
| `wanman task …` | Manage the task pool: `create`, `list`, `get`, `update`, `done`. Supports `--after` dependencies. |
| `wanman initiative …` | Manage long-lived initiatives: `create`, `list`, `get`, `update`. |
| `wanman capsule …` | Manage change capsules: `create`, `list`, `mine`, `get`, `update`. |
| `wanman artifact …` | Store and retrieve structured artifacts locally in SQLite: `put`, `list`, `get`. |
| `wanman watch` | Inspect local `loop-events.ndjson` activity and budget halt events. |
| `wanman run <goal>` | Start a matrix against a one-shot goal with live TUI and circuit breakers. |
| `wanman takeover <path>` | Take over an existing git repo with isolated per-worker git worktrees. |
| `wanman skill:check [path]` | Validate that skill docs reference only real CLI commands. |

Run `wanman --help` for the full, current list.

## Architecture

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

- `wanman <subcommand>` speaks JSON-RPC 2.0 to a Supervisor process.
- The Supervisor owns the message store, context store, task pool, artifact store, and spawns one child process per agent.
- Each agent child is a local Claude Code, Codex, or Antigravity (`agy`) subprocess bound to a per-agent worktree and isolated `$HOME`.

Deep dive: [`docs/architecture.md`](docs/architecture.md).

## Configuration

| Env var | Meaning |
|---------|---------|
| `WANMAN_URL` | Supervisor HTTP URL for the CLI (default `http://localhost:3120`). |
| `WANMAN_AGENT_NAME` | Identifies the current agent; used as default sender/receiver inside agent processes. |
| `WANMAN_RUNTIME` | `agy` (default; aliases: `atg`, `antigravity`), `claude`, or `codex` — selects the per-agent CLI adapter. |
| `WANMAN_MODEL`, `WANMAN_CODEX_MODEL`, `WANMAN_CODEX_REASONING_EFFORT` | Per-runtime model overrides (`WANMAN_MODEL` and Codex model/reasoning effort). |
| `WANMAN_CODEX_FAST` | When set, biases the Codex adapter toward lower-latency defaults. |
| `WANMAN_AGY_MODEL`, `WANMAN_AGY_HIGH_MODEL`, `WANMAN_AGY_STANDARD_MODEL`, `WANMAN_AGY_FAST_MODEL` | Model overrides for the Antigravity (`agy`) adapter (use `default` to omit `--model`). |
| `WANMAN_AGY_EFFORT` | Reasoning effort for `agy` (`low`, `medium`, `high`, `xhigh`, `max`). |
| `WANMAN_AGY_BIN` | Override path to the `agy` binary (falls back to `PATH` and `~/.local/bin/agy`). |
| `WANMAN_WORKTREE_ISOLATION` | Set `1` to enable per-worker git worktrees (`agent/<name>`) or `0` to share one worktree. |
| `WANMAN_TOKEN_BUDGET` / `WANMAN_AGENT_TOKEN_BUDGET` | Global (default `1000000`) and per-agent (default `0` = unlimited) token circuit breakers. |
| `WANMAN_MAX_DURATION_MS` / `WANMAN_TIME_BUDGET_MS` | Global wall-clock duration cap (default `3600000`) and per-spawn timeout (default `600000`). |
| `WANMAN_SKILL_SNAPSHOTS_DIR` | Override where the runtime materializes skill-activation snapshots (default: sibling of the shared-skills dir, falling back to `$TMPDIR/wanman-skill-snapshots`). |

All state (messages, context, tasks, initiatives, capsules, and artifacts) is persisted locally in SQLite (`wanman.db`) — see [`docs/architecture.md`](docs/architecture.md#10-local-persistence--circuit-breakers).

## Agent configs

Agent definitions live in a single JSON file:

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

Each agent entry has:
- `name` — unique identifier used on the message bus.
- `lifecycle` — `24/7` (continuous respawn loop), `on-demand` (idle until triggered), or `idle_cached` (idle until triggered, preserving conversation context across triggers via `claude --resume` or `agy --conversation`). **`idle_cached` is supported on `claude` and `agy`**: pairing it with `runtime: codex` (or `WANMAN_RUNTIME=codex`) is rejected at startup since Codex has no equivalent resume mechanism in this runtime.
- `model` — usually an abstract tier (`high`, `standard`, or `fast`); the runtime adapter maps it to Antigravity (`agy`), Claude, or Codex defaults, with environment overrides available.
- `systemPrompt` — baked-in persona/mission; agents also auto-discover shared skill files under `~/.claude/skills/`, `~/.codex/skills/`, or `~/.gemini/config/skills/`.
- Optional `cron`, `events`, and `tools` fields — see the architecture doc for the full schema.

## Testing

```bash
pnpm typecheck
pnpm test
pnpm exec vitest run --coverage --coverage.reporter=text-summary --coverage.reporter=json-summary --coverage.exclude='**/dist/**'
```

The current coverage target is at least 90% line coverage. The latest verified local run reports `Lines: 90.17%`; the machine-readable summary is written to `coverage/coverage-summary.json`.

## Project structure

```
wanman.dev/
  packages/
    cli/                 wanman CLI (send/recv/task/artifact/run/takeover/...)
    core/                Shared types, JSON-RPC protocol, skills (core/skills/)
    host-sdk/            Host-side SDK for embedding wanman into other tools
    runtime/             Supervisor, agent process manager, SQLite stores, adapters
  docs/                  Architecture and quickstart guides
```

Shared skills shipped today (`packages/core/skills/`):
- `artifact-naming`, `artifact-quality` — conventions for agent-produced artifacts.
- `cross-validation` — CEO consistency checks across agent outputs.
- `research-methodology` — market/data research methodology.
- `wanman-cli` — CLI command reference consumed by agents at runtime.
- `workspace-conventions` — file-system conventions inside agent workspaces.

## Further reading

- [Quickstart](docs/quickstart.md) — first-run walkthrough against any git repo.
- [Architecture](docs/architecture.md) — agent lifecycle, JSON-RPC, stores, adapters.
- [Contributing](CONTRIBUTING.md) — tests, typecheck, commit conventions.

## License

Apache-2.0 — see [LICENSE](LICENSE).
