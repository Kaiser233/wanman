/**
 * Agent lifecycle mode.
 *
 * - `24/7`        — continuous respawn loop. The agent boots a fresh CLI
 *                   subprocess every iteration. Use for always-on roles.
 * - `on-demand`   — idle until triggered (cron / steer / message). Each
 *                   trigger starts a fresh, stateless run.
 * - `idle_cached` — idle until triggered (like `on-demand`), but the runtime
 *                   remembers the previous session id and resumes it on the
 *                   next trigger (via `claude --resume` or `agy --conversation`).
 *                   Combines "no CPU when idle" with "preserved conversation
 *                   context". Supported by Claude and Agy; Codex has no
 *                   equivalent in this runtime today, so the supervisor
 *                   rejects `idle_cached` paired with Codex at startup rather
 *                   than letting it silently degrade to `on-demand` semantics.
 */
export type AgentLifecycle = '24/7' | 'on-demand' | 'idle_cached';

/** Agent runtime backend */
export type AgentRuntime = 'claude' | 'codex' | 'agy';

/** Codex reasoning effort / speed tier */
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Model identifier or abstract tier — runtime-dependent (e.g. 'high', 'standard', 'fast', 'gemini-4-hydrogen-high') */
export type ModelTier = string;

/** Message priority — steer interrupts current work, normal waits */
export type MessagePriority = 'steer' | 'normal';

/** Agent process state */
export type AgentState = 'idle' | 'running' | 'paused' | 'stopped' | 'error';

/** Coarse task/capsule work type */
export type TaskScopeType = 'code' | 'docs' | 'tests' | 'ops' | 'mixed';

/** Mission-board initiative state */
export type InitiativeStatus = 'active' | 'paused' | 'completed' | 'abandoned';

/** PR-sized change capsule state */
export type ChangeCapsuleStatus = 'open' | 'in_review' | 'merged' | 'abandoned';

/** Agent definition — loaded from agents.json config */
export interface AgentDefinition {
  name: string;
  lifecycle: AgentLifecycle;
  /** Runtime backend used to execute the agent process */
  runtime?: AgentRuntime;
  model: ModelTier;
  systemPrompt: string;
  /** Cron expressions for scheduled triggers */
  crons?: string[];
  /** Event types this agent subscribes to */
  events?: string[];
  /** Override ANTHROPIC_BASE_URL for this agent (e.g. LM Studio endpoint) */
  baseUrl?: string;
  /** Override ANTHROPIC_AUTH_TOKEN for this agent */
  apiKey?: string;
}

/** A message between agents or from external sources */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  /** Message type (e.g. 'message', 'event', 'cron') */
  type: string;
  /** Structured payload */
  payload: unknown;
  priority: MessagePriority;
  timestamp: number;
  delivered: boolean;
}

/** Shared context entry — key-value store for inter-agent state */
export interface ContextEntry {
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: number;
}

/** Top-level config loaded from agents.json */
export interface AgentMatrixConfig {
  agents: AgentDefinition[];
  /** SQLite database path */
  dbPath?: string;
  /** HTTP server port */
  port?: number;
  /** Workspace root for agent working directories */
  workspaceRoot?: string;
  /** Git root for repo-aware runs (defaults from workspaceRoot) */
  gitRoot?: string;
  /** Isolate each code-writing worker in its own git worktree & branch */
  worktreeIsolation?: boolean;
  /** Global token budget across all agents (0 = unlimited) */
  tokenBudget?: number;
  /** Per-agent cumulative token budget (0 = unlimited) */
  agentTokenBudget?: number;
  /** Global run wall-clock duration budget in ms (0 = unlimited) */
  maxDurationMs?: number;
  /** Per-spawn execution timeout in ms (0 = unlimited) */
  spawnTimeoutMs?: number;
  /** Top-level goal for the CEO agent to pursue autonomously */
  goal?: string;
}

/** External event pushed into the agent matrix */
export interface ExternalEvent {
  type: string;
  source: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/** Long-running product initiative tracked during takeover */
export interface Initiative {
  id: string;
  title: string;
  goal: string;
  summary: string;
  status: InitiativeStatus;
  priority: number;
  sources: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** PR-sized change package linked to a branch */
export interface ChangeCapsule {
  id: string;
  goal: string;
  ownerAgent: string;
  branch: string;
  baseCommit: string;
  allowedPaths: string[];
  acceptance: string;
  reviewer: string;
  status: ChangeCapsuleStatus;
  createdAt: number;
  updatedAt: number;
  initiativeId?: string;
  taskId?: string;
  subsystem?: string;
  scopeType?: TaskScopeType;
  blockedBy?: string[];
  supersedes?: string;
}

// ── Auth types ──

/** Supported CLI auth providers */
export type AuthProviderName = 'github' | 'claude' | 'codex' | 'agy';

/** Auth status for a provider */
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'pending' | 'error';

/** Auth provider info returned by auth.* RPC methods */
export interface AuthProviderInfo {
  name: AuthProviderName;
  status: AuthStatus;
  loginUrl?: string;
  loginCode?: string;
  error?: string;
}

/** Per-agent runtime telemetry included in health responses */
export interface HealthAgentInfo {
  name: string;
  state: AgentState;
  lifecycle: AgentLifecycle;
  runtime?: AgentRuntime;
  model?: string;
  currentTool?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  branch?: string;
  worktreePath?: string;
  haltedReason?: string;
}

/** Run-wide budget and circuit-breaker telemetry */
export interface HealthBudgetInfo {
  totalTokens: number;
  tokenBudget: number | null;
  agentTokenBudget: number | null;
  elapsedMs: number;
  maxDurationMs: number | null;
  spawnTimeoutMs: number | null;
  halted: boolean;
  haltReason?: string;
}

/** Active per-agent git worktree assignment */
export interface HealthWorktreeInfo {
  agent: string;
  name: string;
  path: string;
  branch: string;
}

/** Health check response */
export interface HealthResponse {
  status: 'ok';
  agents: HealthAgentInfo[];
  budget?: HealthBudgetInfo;
  worktrees?: HealthWorktreeInfo[];
  timestamp: string;
}
