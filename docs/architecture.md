# Architecture

**English** | [中文](architecture.zh.md) | [日本語](architecture.ja.md)

This document is the tour a developer new to the wanman codebase should read first. It covers the shape of the supervisor, how agents are spawned and talk to each other, and where state lives.

## 1. System overview

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

The CLI is a thin JSON-RPC 2.0 client. Everything interesting — process management, persistence, routing — lives in the supervisor. The supervisor is a plain local Node.js process; the CLI only needs `WANMAN_URL` to reach it.

## 2. Agent lifecycles

Every agent has a `lifecycle` declared in the agents config:

### 2.1 `24/7` — continuous respawn

```
start()
  +-> runLoop()
        +- relay.recv()            -- pull pending messages
        +- spawnAgent()            -- boot the CLI subprocess with those as prompt
        +- wait()                  -- block until the subprocess exits
        +- sleep(RESPAWN_DELAY_MS) -- cooldown
        +- repeat
```

- Each loop iteration spawns one fresh CLI subprocess.
- If messages are pending, they become the initial prompt. Otherwise a default "you are alive, check your inbox" prompt is used.
- Exit → cooldown → respawn. The loop is interrupted by `handleSteer()` (see below).

### 2.2 `on-demand` — idle-until-triggered

```
start()
  +-> state = 'idle'   (no CLI subprocess running)
        +- trigger() or handleSteer()
             +- relay.recv()
             +- spawnAgent()
             +- wait()
        +- state = 'idle' again
```

- Initial state is `idle`; no CPU is spent until something pokes it.
- A steer-priority message or a cron tick triggers a single execution, after which the agent falls back to `idle`.
- Each spawn is stateless: the next trigger gets a fresh CLI session.

### 2.3 `idle_cached` — idle, but with resumed context (Claude and Agy)

```
start()
  +-> state = 'idle'           (no CLI subprocess running)
  +-> lastSessionId = null

trigger() / handleSteer()
  +- relay.recv()
  +- spawnAgent({ resumeSessionId: lastSessionId })        # claude --resume <id> / agy --conversation <id>
  +- onSessionId(id => lastSessionId = id)                 # captured from init event
  +- wait()
  +- if resumeMissed():                                    # stale session (Claude)
       lastSessionId = null
       respawn without --resume                            # cold-start fallback
  +- state = 'idle' again      (but lastSessionId is preserved)
```

- Same idle CPU profile as `on-demand`, but conversation context survives idle periods because the next spawn passes the captured `session_id` via `claude --resume <id>` or `agy --conversation <id>`.
- The first trigger always cold-starts (no captured session yet).
- For Claude Code, if the local CLI has dropped the session id (rotated, manually deleted, etc.), the runtime detects the failure via stderr + exit code, clears the cached id, and re-spawns once without `--resume`. No agent gets stranded.
- Useful for stateful long-running roles where keeping a process alive forever would be wasteful but losing context every trigger is also wrong (e.g. a "support" agent that should remember the customer between messages).
- **Claude and Agy only.** Codex has no equivalent resume mechanism in this runtime today. Pairing `idle_cached` with `runtime: codex` (or letting `WANMAN_RUNTIME=codex` flip the effective runtime) is rejected at supervisor startup so the misconfig surfaces loudly instead of silently degrading to `on-demand` semantics.

### 2.4 Agent states

| State | Meaning |
|-------|---------|
| `idle` | Waiting (on-demand normal state). |
| `running` | A Claude Code, Codex, or Antigravity (`agy`) subprocess is executing. |
| `stopped` | Manually stopped or shutting down. |
| `error` | Recent crash; the supervisor will retry. |

## 3. Message system

### 3.1 Priorities

| Priority | Value | Effect |
|----------|-------|--------|
| `steer` | 0 | **Interrupts** the target's current subprocess; next loop iteration picks it up first. |
| `followUp` | 1 | Normal queueing; handled in timestamp order on the next loop. |

### 3.2 Steer mechanism

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

The relay's steer callback tells the `AgentProcess` to SIGKILL its current Claude/Codex child. The run loop's normal respawn path then picks the steer message up first because of the SQL ordering.

### 3.3 Delivery guarantees

- Messages are persisted in SQLite (`messages` table) before `send()` returns.
- `recv()` returns pending (`delivered = 0`) rows *and* marks them delivered in a single transaction — no double-delivery.
- Ordering: `ORDER BY CASE priority WHEN 'steer' THEN 0 ELSE 1 END, timestamp ASC`.

### 3.4 Message shape

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

Cross-agent shared key/value storage in SQLite. Useful for system-wide state like "last build result" or "current MRR".

```ts
interface ContextEntry {
  key: string
  value: string
  updatedBy: string  // agent name
  updatedAt: number  // unix ms
}
```

RPC methods: `context.get`, `context.set`, `context.list`. `set` is an upsert (`INSERT ... ON CONFLICT DO UPDATE`).

## 5. Task pool, initiatives, artifacts, capsules

The supervisor also owns structured state beyond raw messages:

- **TaskPool** — agent-owned tasks with status (`pending`, `in_progress`, `done`, `blocked`), priorities, and `--after` dependencies. `wanman task list` renders a dependency-aware view.
- **InitiativeBoard** — longer-lived multi-task initiatives.
- **ArtifactStore** — structured outputs (research summaries, plans, etc.) persisted locally in SQLite via `wanman artifact put`. Artifacts have kind, path, content, and JSON metadata.
- **ChangeCapsulePool** — proposed change bundles agents can review.

All of these are SQLite tables under a single local `wanman.db`, reachable via JSON-RPC.

## 6. External events & cron

Two asynchronous inputs to the matrix besides agent-to-agent messages:

- **`POST /events`** — an external system (CI, a webhook, a human script) pushes an `ExternalEvent` object. The supervisor iterates agents and, for any whose `definition.events[]` includes the event type, enqueues a follow-up message with the serialized payload.
- **CronScheduler** — runs every 60 seconds, checks each agent's `cron` expression, and fires a follow-up message (plus a `handleSteer()` for on-demand agents) when it matches. Standard 5-field cron: `min hour dom mon dow`.

These are the two seams where wanman plugs into "the rest of your infrastructure" without hard-coding any particular webhook provider.

## 7. Runtime adapters

Each agent child is an Antigravity (`agy`), Claude Code, or Codex subprocess. The supervisor selects between them via `WANMAN_RUNTIME` (`agy` default with aliases `atg` / `antigravity`, `claude`, or `codex`) and a per-agent override if present.

- `agy-adapter.ts` — targets Antigravity CLI (`agy --input-format stream-json --output-format stream-json --dangerously-skip-permissions`), resolving the binary via `WANMAN_AGY_BIN`, `PATH`, or `~/.local/bin/agy`. Maps abstract tiers `high` / `standard` / `fast` to `gemini-4-hydrogen-high` / `gemini-4-carbon-medium` / `gemini-3.8-flash-low` by default, controlled by `WANMAN_AGY_MODEL`, `WANMAN_AGY_HIGH_MODEL`, `WANMAN_AGY_STANDARD_MODEL`, `WANMAN_AGY_FAST_MODEL`, and `WANMAN_AGY_EFFORT` (`low|medium|high|xhigh|max`), with `AGY_CLI_DISABLE_AUTO_UPDATE=true` and `AGY_CLI_HIDE_LOGO=true` set automatically.
- `claude-adapter.ts` / `claude-code.ts` — spawns `claude` with the agent's system prompt, injects skill files, streams structured events back to the supervisor.
- `codex-adapter.ts` — same shape, targeting `@openai/codex`. `WANMAN_CODEX_MODEL` and `WANMAN_CODEX_REASONING_EFFORT` control model selection.

All adapters emit the same `AgentRunEvent` stream, so the supervisor and CLI don't care which is running. Adding a new adapter is a matter of implementing that event contract and registering it in `agent-adapter.ts` / `agent-process.ts`.

## 8. Worktree and home isolation

Before spawning workers, the supervisor sets up:

- A base **worktree** materialized from `HEAD` under `.wanman/worktree/`, plus **per-worker isolated git worktrees** under `.wanman/worktrees/<worker>/` (branch `agent/<worker>`) when `worktreeIsolation` is enabled (on by default in `wanman takeover`). Each code-writing worker (`dev`, `dev-*`, `devops`, `worker`, `worker-*`) receives `$WANMAN_AGENT_WORKTREE` and `$WANMAN_AGENT_BRANCH` and works in its own branch; unmerged or dirty worker branches are preserved automatically when dynamic clones are torn down.
- A **per-agent `$HOME`** under `.wanman/home/<agent>/` with generated `wanman` and `pnpm` wrappers. Shell profile writes, `.npmrc` edits, etc. stay contained.
- **Runtime-specific auth & state directories** under that home: `.claude/` and `.codex/` are isolated per agent, while `.gemini/` is selectively bridged (symlinking `GEMINI.md`, `antigravity-cli/settings.json`, `antigravity-cli/keybindings.json`, and `config/{config.json,mcp_config.json,hooks.json,plugins,agents}` when present; symlinking `Library/Keychains` on macOS) so host auth/config are available while `antigravity-cli` session directories (`conversations/`, `brain/`, `cache/`) and `config/skills/` stay isolated per agent.

The `wanman` wrapper inside each agent's `$PATH` points at the same CLI binary but presets `WANMAN_AGENT_NAME` so `wanman recv` without args "just works" from the agent's perspective.

## 9. Shared skills

`packages/core/skills/*/SKILL.md` ship alongside the runtime bundle. At supervisor startup, shared skills are installed/linked into each agent's `~/.claude/skills/`, `~/.codex/skills/`, and `~/.gemini/config/skills/` so Claude Code, Codex, and Antigravity (`agy`) auto-discover them.

Skill snapshots — immutable copies tied to a specific run — are written to the directory resolved by `WANMAN_SKILL_SNAPSHOTS_DIR`, or a sibling of the shared-skills dir, or `$TMPDIR/wanman-skill-snapshots` as a last resort. This is the mechanism that lets you audit exactly which skill version an agent had available for a given task.

Skills shipped today:
- `artifact-naming`, `artifact-quality` — conventions for agent-produced artifacts.
- `cross-validation` — CEO consistency checks across agent outputs.
- `research-methodology` — market/data research methodology.
- `wanman-cli` — CLI command reference agents read at runtime.
- `workspace-conventions` — file layout agents should follow inside their workspace.

## 10. Local persistence & circuit breakers

- **Local SQLite (`dbPath` in agents config)** — always present, zero cloud dependencies. Stores messages, context, tasks, initiatives, capsules, and artifacts (`ArtifactStore`) durably across supervisor restarts inside the same workspace.
- **Hard circuit breakers** — Supervisor enforces live global token budgets (`tokenBudget` / `--max-tokens`), per-agent token budgets (`agentTokenBudget` / `--agent-max-tokens`), global wall-clock duration caps (`maxDurationMs` / `--max-duration`), and per-spawn timeouts (`spawnTimeoutMs` / `--spawn-timeout`). When a budget trips, Supervisor stops affected or all agents immediately, marks `/health.budget.halted = true`, emits `run.halted`, and lets the CLI print a structured stop report.

## 11. HTTP surface at a glance

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Supervisor + per-agent telemetry (`runtime`, `model`, `currentTool`, `totalTokens`, `branch`), `budget`, and `worktrees`. |
| `/rpc` | POST | JSON-RPC 2.0 — the main CLI surface. |
| `/events` | POST | External-event ingress. |

Main RPC methods:

| Method | Purpose |
|--------|---------|
| `agent.send` / `agent.recv` / `agent.list` | Inter-agent messaging and live agent telemetry. |
| `context.get` / `context.set` / `context.list` | Shared context. |
| `task.*` / `initiative.*` / `capsule.*` / `artifact.*` | Structured local SQLite state. |
| `event.push` | Same as `POST /events`, for RPC clients. |
| `health.check` | Health snapshot over RPC. |

Errors use the standard JSON-RPC codes (`-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal) plus `-32000` (agent not found) and `-32001` (agent not running).

## 12. Where code lives

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

For the CLI surface and env vars, see the [README](../README.md#cli-commands).
