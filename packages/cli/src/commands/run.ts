import { createDefaultRunOptions, normalizeRuntime, type RunOptions } from '@wanman/host-sdk'
import { detectProjectDir as detectRunProjectDir, runGoal } from '../run-host.js'
import {
  type ExecutionContext,
  type ExecutionHooks,
  type HealthAgent,
  type PollExecutionContext,
  type ProjectRunSpec,
  type TaskInfo,
} from '../execution-session.js'

export type {
  ExecutionContext,
  ExecutionHooks,
  HealthAgent,
  PollExecutionContext,
  ProjectRunSpec,
  TaskInfo,
}

// ── Arg parsing ──

/** @internal exported for testing */
export function parseOptions(args: string[]): { goal: string; opts: RunOptions } {
  const goal = args[0]!
  const opts = createDefaultRunOptions()

  const normalizeCodexReasoningEffort = (value: string): NonNullable<RunOptions['codexReasoningEffort']> => {
    switch (value.trim().toLowerCase()) {
      case 'low':
      case 'fast':
        return 'low'
      case 'medium':
      case 'balanced':
        return 'medium'
      case 'high':
      case 'deep':
        return 'high'
      case 'xhigh':
      case 'max':
        return 'xhigh'
      default:
        throw new Error(`Invalid codex effort/speed: ${value}. Use low|medium|high|xhigh or fast|balanced|deep|max.`)
    }
  }

  const normalizeAgyEffort = (value: string): NonNullable<RunOptions['agyEffort']> => {
    switch (value.trim().toLowerCase()) {
      case 'low':
      case 'fast':
        return 'low'
      case 'medium':
      case 'balanced':
        return 'medium'
      case 'high':
      case 'deep':
        return 'high'
      case 'xhigh':
        return 'xhigh'
      case 'max':
        return 'max'
      default:
        throw new Error(`Invalid agy effort: ${value}. Use low|medium|high|xhigh|max or fast|balanced|deep.`)
    }
  }

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--loops': opts.loops = parseInt(args[++i]!, 10); break
      case '--poll': opts.pollInterval = parseInt(args[++i]!, 10); break
      case '--runtime': opts.runtime = normalizeRuntime(args[++i]); break
      case '--codex-model': opts.codexModel = args[++i]; break
      case '--codex-effort': opts.codexReasoningEffort = normalizeCodexReasoningEffort(args[++i]!); break
      case '--codex-speed': opts.codexReasoningEffort = normalizeCodexReasoningEffort(args[++i]!); break
      case '--agy-model': opts.agyModel = args[++i]; break
      case '--agy-effort': opts.agyEffort = normalizeAgyEffort(args[++i]!); break
      case '--agy-speed': opts.agyEffort = normalizeAgyEffort(args[++i]!); break
      case '--max-tokens': opts.maxTokens = parseInt(args[++i]!, 10); break
      case '--agent-max-tokens': opts.agentMaxTokens = parseInt(args[++i]!, 10); break
      case '--max-duration': opts.maxDurationSec = parseInt(args[++i]!, 10); break
      case '--spawn-timeout': opts.spawnTimeoutSec = parseInt(args[++i]!, 10); break
      case '--worktree-isolation': opts.worktreeIsolation = true; break
      case '--no-worktree-isolation': opts.worktreeIsolation = false; break
      case '--config': opts.configPath = args[++i]; break
      case '--worker-url': opts.workerUrl = args[++i]; break
      case '--worker-model': opts.workerModel = args[++i]; break
      case '--worker-key': opts.workerKey = args[++i]!; break
      case '--keep': opts.keep = true; break
      case '--output': opts.output = args[++i]!; break
      case '--project-dir': opts.projectDir = args[++i]; break
      case '--infinite': opts.infinite = true; break
      case '--error-limit': opts.errorLimit = parseInt(args[++i]!, 10); break
    }
  }
  if (opts.infinite) opts.loops = Infinity
  return { goal, opts }
}

export function detectProjectDir(dir = process.cwd()): string | null {
  return detectRunProjectDir(dir)
}

const RUN_HELP = `wanman run — Goal-Driven Local Agent Runner

Usage:
  wanman run <goal> [options]

If the current directory contains agents.json, it will be used as the
project directory. Agent skills are loaded from agents/{name}/AGENT.md
and shared skills from skills/{name}/SKILL.md.

The supervisor and agents run directly on your local machine — no cloud DB,
no container. Authenticate your agent CLI on the host ('agy', 'claude login',
or 'codex login') before running.

Options:
  --loops <n>             Max CEO loops (default: 100)
  --infinite              Run indefinitely (exit via Ctrl+C, budget limit, or error limit)
  --error-limit <n>       Max consecutive error loops before exit (default: 20)
  --poll <seconds>        Poll interval (default: 15)
  --runtime <name>        Agent runtime: agy (default; aliases: atg, antigravity), claude, or codex
  --agy-model <name>      Antigravity (agy) model override
  --agy-effort <lvl>      Antigravity (agy) reasoning effort: low|medium|high|xhigh|max
  --agy-speed <lvl>       Alias for --agy-effort using fast|balanced|deep|max
  --codex-model <name>    Codex model override
  --codex-effort <lvl>    Codex reasoning effort: low|medium|high|xhigh
  --codex-speed <lvl>     Alias for --codex-effort using fast|balanced|deep|max
  --max-tokens <n>        Global token budget circuit breaker (default: 1000000; 0 = unlimited)
  --agent-max-tokens <n>  Per-agent token budget circuit breaker (default: 0 = unlimited)
  --max-duration <sec>    Global wall-clock duration budget in seconds (default: 3600; 0 = unlimited)
  --spawn-timeout <sec>   Per-spawn timeout in seconds (default: 600; 0 = unlimited)
  --worktree-isolation    Isolate each code-writing worker into its own git worktree & branch
  --no-worktree-isolation Disable per-worker git worktree isolation
  --project-dir <path>    Working directory to run against (defaults to current dir)
  --worker-url <url>      Worker LLM API endpoint (hybrid mode)
  --worker-model <m>      Worker model name
  --worker-key <key>      Worker API key (default: lmstudio)
  --keep                  Keep the supervisor alive on exit
  --output <path>         Write deliverables to (default: ./deliverables)

Project directory structure:
  agents.json                Agent role definitions
  agents/{name}/AGENT.md     Per-agent skill files
  skills/{name}/SKILL.md     Shared skills (optional)

Environment:
  WANMAN_RUNTIME             Override agent runtime (agy, claude, or codex)
  WANMAN_AGY_MODEL           Override Antigravity (agy) model
  WANMAN_AGY_HIGH_MODEL      Override agy 'high' tier model (default: gemini-4-hydrogen-high)
  WANMAN_AGY_STANDARD_MODEL  Override agy 'standard' tier model (default: gemini-4-carbon-medium)
  WANMAN_AGY_FAST_MODEL      Override agy 'fast' tier model (default: gemini-3.8-flash-low)
  WANMAN_AGY_EFFORT          Override Antigravity (agy) reasoning effort
  WANMAN_TOKEN_BUDGET        Global token budget override
  WANMAN_AGENT_TOKEN_BUDGET  Per-agent token budget override
  WANMAN_MAX_DURATION_MS     Global duration budget override in ms
  WANMAN_TIME_BUDGET_MS      Per-spawn timeout override in ms
`

export async function runWithGoal(goal: string, opts: RunOptions, spec: ProjectRunSpec = {}): Promise<void> {
  await runGoal(goal, opts, spec)
}

export async function runCommand(args: string[]): Promise<void> {
  if (!args[0] || args[0] === '--help' || args[0] === '-h') {
    console.log(RUN_HELP)
    process.exit(args[0] ? 0 : 1)
  }

  const { goal, opts } = parseOptions(args)
  await runWithGoal(goal, opts)
}
