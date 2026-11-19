import type { AgentRuntime } from '@wanman/core'

export type AgyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const DEFAULT_MAX_TOKENS = 1_000_000
export const DEFAULT_MAX_DURATION_SEC = 3600
export const DEFAULT_SPAWN_TIMEOUT_SEC = 600

export function normalizeRuntime(value?: string | null): AgentRuntime {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'claude') return 'claude'
  if (normalized === 'codex') return 'codex'
  return 'agy'
}

export interface RunOptions {
  loops: number
  pollInterval: number
  runtime?: AgentRuntime
  codexModel?: string
  codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  agyModel?: string
  agyEffort?: AgyEffort
  configPath?: string
  projectDir?: string
  workerUrl?: string
  workerModel?: string
  workerKey?: string
  /** Global run token budget across all agents (0 = unlimited) */
  maxTokens: number
  /** Per-agent cumulative token budget (0 = unlimited) */
  agentMaxTokens: number
  /** Global wall-clock duration budget in seconds (0 = unlimited) */
  maxDurationSec: number
  /** Per-spawn execution timeout in seconds (0 = unlimited) */
  spawnTimeoutSec: number
  /** Isolate code-writing workers into dedicated git worktrees & branches */
  worktreeIsolation: boolean
  keep: boolean
  output: string
  infinite: boolean
  errorLimit: number
}

export function createDefaultRunOptions(): RunOptions {
  return {
    loops: 100,
    pollInterval: 15,
    runtime: undefined,
    codexModel: undefined,
    codexReasoningEffort: undefined,
    agyModel: undefined,
    agyEffort: undefined,
    configPath: undefined,
    projectDir: undefined,
    workerUrl: undefined,
    workerModel: undefined,
    workerKey: 'lmstudio',
    maxTokens: DEFAULT_MAX_TOKENS,
    agentMaxTokens: 0,
    maxDurationSec: DEFAULT_MAX_DURATION_SEC,
    spawnTimeoutSec: DEFAULT_SPAWN_TIMEOUT_SEC,
    worktreeIsolation: false,
    keep: false,
    output: './deliverables',
    infinite: false,
    errorLimit: 20,
  }
}

export function createRunOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  const options = {
    ...createDefaultRunOptions(),
    ...overrides,
  }

  if (options.runtime !== undefined) {
    options.runtime = normalizeRuntime(options.runtime)
  }

  if (options.infinite) options.loops = Infinity

  return options
}

export function createTakeoverRunOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return createRunOptions({
    infinite: true,
    loops: Infinity,
    worktreeIsolation: true,
    ...overrides,
  })
}
