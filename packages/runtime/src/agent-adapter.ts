import type { ChildProcess } from 'child_process';
import type { AgentDefinition, AgentRuntime, ModelTier } from '@wanman/core';
import { AgyAdapter } from './agy-adapter.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';

export interface AgentRunEvent extends Record<string, unknown> {
  type: string;
}

export interface AgentRunHandle {
  proc: ChildProcess;
  sendMessage(content: string, sessionId?: string): void;
  kill(): void;
  wait(): Promise<number>;
  onEvent(handler: (event: AgentRunEvent) => void): void;
  onResult(handler: (result: string, isError: boolean) => void): void;
  /**
   * Adapter-reported session id (e.g. Claude `system/init` event). May fire
   * zero, one, or multiple times depending on the adapter. Adapters that
   * cannot report a session id may simply never invoke the handler.
   */
  onSessionId?(handler: (sessionId: string) => void): void;
  onExit(handler: (code: number) => void): void;
  /**
   * True when the adapter attempted to resume a session id but the runtime
   * could not find it locally. Used by callers to fall back to a cold start.
   * Adapters without resume support always return false.
   */
  resumeMissed?(): boolean;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentRunOptions {
  runtime: AgentRuntime;
  model: ModelTier;
  reasoningEffort?: ReasoningEffort;
  /**
   * Codex-only: enable fast mode (`/fast on`).
   * Adds `-c service_tier="fast"` and `-c features.fast_mode=true`,
   * which ~1.5x throughput at ~2x credit cost.
   * Ignored when runtime !== 'codex'.
   */
  fast?: boolean;
  systemPrompt: string;
  cwd: string;
  initialMessage?: string;
  sessionId?: string;
  /**
   * Resume a previously-captured session. Claude passes `--resume <id>`,
   * Agy passes `--conversation <id>`. Other adapters may ignore it. When the
   * session cannot be found locally, `AgentRunHandle.resumeMissed()` returns
   * true so the caller can retry without resume.
   */
  resumeSessionId?: string;
  env?: Record<string, string>;
  runAsUser?: string;
}

export interface AgentAdapter {
  readonly runtime: AgentRuntime;
  startRun(opts: AgentRunOptions): AgentRunHandle;
}

export function normalizeAgentRuntime(value?: string | null): AgentRuntime {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'codex') return 'codex';
  if (normalized === 'agy' || normalized === 'atg' || normalized === 'antigravity') return 'agy';
  return 'claude';
}

/**
 * Resolve a model identifier for the target runtime.
 *
 * Generated configs use abstract tiers ('high', 'standard') so they are not
 * tied to a single provider's concrete model names. Runtime-specific defaults
 * stay here, where operators can override them with env vars.
 */
type ModelQuality = 'high' | 'standard';

const ABSTRACT_MODEL_TIER: Record<string, ModelQuality> = {
  'high': 'high',
  'standard': 'standard',
};

const CLAUDE_MODEL_TIER: Record<string, ModelQuality> = {
  'opus': 'high',
  'claude-opus-4-6': 'high',
  'sonnet': 'standard',
  'claude-sonnet-4-6': 'standard',
  'haiku': 'standard',
  'claude-haiku-4-5': 'standard',
};

const FALLBACK_RUNTIME_MODEL_DEFAULTS: Record<AgentRuntime, Record<ModelQuality, string>> = {
  claude: { high: 'opus', standard: 'sonnet' },
  codex: { high: 'gpt-5.4', standard: 'gpt-5.4' },
  agy: { high: 'gemini-4-hydrogen-high', standard: 'gemini-4-carbon-medium' },
};

function envNonEmpty(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function providerModelOverride(runtime: AgentRuntime): string | undefined {
  if (runtime === 'codex') return envNonEmpty('WANMAN_CODEX_MODEL');
  if (runtime === 'agy') return envNonEmpty('WANMAN_AGY_MODEL');
  return envNonEmpty('WANMAN_CLAUDE_MODEL');
}

function runtimeDefaultModel(runtime: AgentRuntime, tier: ModelQuality): string {
  const runtimeKey = runtime.toUpperCase();
  const tierKey = tier.toUpperCase();
  return envNonEmpty(`WANMAN_${runtimeKey}_${tierKey}_MODEL`)
    ?? envNonEmpty(`WANMAN_${tierKey}_MODEL`)
    ?? providerModelOverride(runtime)
    ?? envNonEmpty('WANMAN_MODEL')
    ?? FALLBACK_RUNTIME_MODEL_DEFAULTS[runtime][tier];
}

export function resolveModel(model: string, runtime: AgentRuntime): string {
  const normalized = model.trim().toLowerCase();
  if (normalized === 'default' && runtime === 'agy') {
    return providerModelOverride(runtime) ?? envNonEmpty('WANMAN_MODEL') ?? 'default';
  }
  const tier = ABSTRACT_MODEL_TIER[normalized]
    ?? (runtime === 'claude' ? undefined : CLAUDE_MODEL_TIER[normalized]);
  if (!tier) return model;
  return runtimeDefaultModel(runtime, tier);
}

export function resolveAgentRuntime(definition: AgentDefinition): AgentRuntime {
  return normalizeAgentRuntime(process.env['WANMAN_RUNTIME'] ?? definition.runtime);
}

export function createAgentAdapter(runtime: AgentRuntime): AgentAdapter {
  if (runtime === 'codex') {
    return new CodexAdapter();
  }
  if (runtime === 'agy') {
    return new AgyAdapter();
  }
  return new ClaudeAdapter();
}
