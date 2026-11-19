/**
 * TUI Dashboard — renders live agent/task/budget/worktree/log state to the terminal.
 *
 * Uses `log-update` for in-place refresh and `chalk` for color.
 * Designed for `wanman run` and `wanman takeover` dashboard loops.
 */

import type {
  HealthAgent,
  HealthBudget,
  HealthWorktree,
  RuntimeArtifact,
  TaskInfo,
} from '../runtime-client.js'
import logUpdate from 'log-update'
import chalk from 'chalk'

// ── Types ──

export interface DashboardState {
  goal: string
  loop: number
  maxLoops: number
  /** Elapsed milliseconds since run started */
  elapsed: number
  /** Optional active branch / PR context label */
  branchLabel?: string
  /** Optional budget & circuit breaker telemetry */
  budget?: HealthBudget
  /** Active per-agent git worktree assignments */
  worktrees?: HealthWorktree[]
  agents: HealthAgent[]
  tasks: Pick<TaskInfo, 'id' | 'title' | 'status' | 'assignee' | 'priority' | 'result'>[]
  logs: string[]
  artifacts: RuntimeArtifact[]
}

export interface RunReportInput {
  goal: string
  elapsedMs: number
  haltReason?: string
  budget?: HealthBudget
  agents: HealthAgent[]
  tasks: Pick<TaskInfo, 'id' | 'title' | 'status' | 'assignee'>[]
  worktrees?: HealthWorktree[]
  branchSummary?: Array<{ branch: string; ahead: number; modified: number; prUrl?: string }>
}

// ── Helpers ──

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`
  return `${m}m${String(s).padStart(2, '0')}s`
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function renderProgressBar(used: number, limit: number, width = 14): string {
  if (limit <= 0) return ''
  const ratio = Math.min(1, Math.max(0, used / limit))
  const filled = Math.round(ratio * width)
  const empty = Math.max(0, width - filled)
  const bar = '█'.repeat(filled) + '░'.repeat(empty)
  if (ratio >= 1) return chalk.red(bar)
  if (ratio >= 0.8) return chalk.yellow(bar)
  return chalk.green(bar)
}

function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max))
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

const STATUS_ICON: Record<string, string> = {
  running: chalk.green('●'),
  idle: chalk.gray('○'),
  exited: chalk.yellow('◆'),
  stopped: chalk.red('■'),
  paused: chalk.yellow('⏸'),
  error: chalk.red('✖'),
  spawning: chalk.cyan('◎'),
}

const TASK_ICON: Record<string, string> = {
  done: chalk.green('✓'),
  in_progress: chalk.yellow('⚡'),
  review: chalk.blue('◉'),
  assigned: chalk.cyan('▶'),
  pending: chalk.gray('…'),
  failed: chalk.red('✖'),
}

function agentIcon(state: string): string {
  return STATUS_ICON[state] ?? chalk.gray('?')
}

function taskIcon(status: string): string {
  return TASK_ICON[status] ?? chalk.gray('?')
}

function formatLogLine(raw: string, maxLen: number): string {
  try {
    const obj = JSON.parse(raw)
    const ts = obj.ts ? new Date(obj.ts).toLocaleTimeString('en-GB', { hour12: false }) : ''
    const scope = obj.scope || ''
    const msg = obj.msg || ''
    const extras: string[] = []
    if (obj.agent) extras.push(obj.agent)
    if (obj.tool) extras.push(`tool:${obj.tool}`)
    if (obj.task) extras.push(`task:${obj.task}`)
    const extra = extras.length ? chalk.dim(` (${extras.join(', ')})`) : ''
    const formatted = `${chalk.dim(ts)} ${chalk.cyan(scope.padEnd(14))} ${chalk.white(msg)}${extra}`
    return truncate(formatted, maxLen + 40)
  } catch {
    return chalk.gray(truncate(raw, maxLen))
  }
}

function formatAgentRow(agent: HealthAgent): string {
  const icon = agentIcon(agent.state)
  const name = chalk.white(agent.name.padEnd(11))
  const stateColor = agent.state === 'running'
    ? chalk.green(agent.state.padEnd(8))
    : agent.state === 'error' || agent.state === 'stopped'
      ? chalk.red(agent.state.padEnd(8))
      : chalk.dim(agent.state.padEnd(8))

  const parts: string[] = [`    ${icon} ${name} ${stateColor}`]

  if (agent.runtime || agent.model) {
    const runtimeLabel = agent.runtime ?? '?'
    const modelLabel = agent.model ? truncate(agent.model, 24) : 'default'
    parts.push(chalk.cyan(`${runtimeLabel}/${modelLabel}`))
  }

  if (agent.currentTool) {
    parts.push(chalk.yellow(`⚙ ${agent.currentTool}`))
  }

  if (typeof agent.totalTokens === 'number' && agent.totalTokens > 0) {
    parts.push(chalk.magenta(`${formatTokens(agent.totalTokens)} tok`))
  }

  if (agent.branch) {
    parts.push(chalk.dim(`[${agent.branch}]`))
  }

  if (agent.haltedReason) {
    parts.push(chalk.red(`⛔ ${agent.haltedReason}`))
  }

  return parts.join('  ')
}

// ── Render ──

export function formatDashboard(state: DashboardState): string {
  const { goal, loop, maxLoops, elapsed, branchLabel, budget, worktrees, agents, tasks, logs, artifacts } = state
  const w = Math.min(process.stdout.columns || 100, 116)
  const hr = chalk.gray('─'.repeat(w))

  const lines: string[] = []

  lines.push('')
  lines.push(hr)
  lines.push(
    chalk.bold('  wanman')
    + chalk.gray(' — ')
    + chalk.cyan(truncate(goal, w - 16)),
  )

  const loopText = Number.isFinite(maxLoops) ? `${loop}/${maxLoops}` : `${loop}/∞`
  const durationLimit = budget?.maxDurationMs ? ` / ${formatElapsed(budget.maxDurationMs)}` : ''
  const metaSegments = [
    `${chalk.gray('⏱ ')}${formatElapsed(elapsed)}${chalk.dim(durationLimit)}`,
    `${chalk.gray('Loop ')}${chalk.white(loopText)}`,
  ]
  if (branchLabel) {
    metaSegments.push(`${chalk.gray('Git: ')}${chalk.dim(branchLabel)}`)
  } else if (worktrees && worktrees.length > 0) {
    metaSegments.push(`${chalk.gray('Worktrees: ')}${chalk.dim(worktrees.map(wt => wt.branch).join(', '))}`)
  }
  lines.push(`  ${metaSegments.join(chalk.gray(' │ '))}`)

  if (budget) {
    const used = formatTokens(budget.totalTokens)
    if (budget.tokenBudget && budget.tokenBudget > 0) {
      const pct = Math.min(999, Math.round((budget.totalTokens / budget.tokenBudget) * 100))
      const bar = renderProgressBar(budget.totalTokens, budget.tokenBudget)
      lines.push(
        `  ${chalk.gray('Tokens: ')}${chalk.white(used)} ${chalk.dim(`/ ${formatTokens(budget.tokenBudget)} (${pct}%)`)} ${bar}`,
      )
    } else if (budget.totalTokens > 0) {
      lines.push(`  ${chalk.gray('Tokens: ')}${chalk.white(used)} ${chalk.dim('(unlimited)')}`)
    }

    if (budget.halted) {
      lines.push(
        chalk.bgRed.white.bold(`  ⛔ CIRCUIT BREAKER HALTED: ${budget.haltReason ?? 'budget_exceeded'}  `),
      )
    }
  }
  lines.push(hr)

  // Agents
  lines.push(chalk.bold('  Agents'))
  if (agents.length === 0) {
    lines.push(chalk.gray('    (waiting for health...)'))
  } else {
    for (const a of agents) {
      lines.push(formatAgentRow(a))
    }
  }
  lines.push('')

  // Tasks
  lines.push(chalk.bold('  Tasks'))
  if (tasks.length === 0) {
    lines.push(chalk.gray('    (no tasks yet)'))
  } else {
    const order: Record<string, number> = { in_progress: 0, review: 1, assigned: 2, pending: 3, failed: 4, done: 5 }
    const sorted = [...tasks].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
    for (const t of sorted) {
      const icon = taskIcon(t.status)
      const assignee = t.assignee ? chalk.dim(`→ ${t.assignee}`) : ''
      const pri = chalk.dim(`P${t.priority}`)
      const title = truncate(t.title, w - 30)
      lines.push(`    ${icon} ${pri} ${chalk.white(title)} ${assignee}`)
    }
    const done = tasks.filter(t => t.status === 'done').length
    const active = tasks.filter(t => ['in_progress', 'review'].includes(t.status)).length
    const waiting = tasks.filter(t => ['pending', 'assigned'].includes(t.status)).length
    lines.push(
      chalk.gray(`    ── ${done} done, ${active} active, ${waiting} waiting ──`),
    )
  }
  lines.push('')

  // Logs
  lines.push(chalk.bold('  Logs'))
  if (logs.length === 0) {
    lines.push(chalk.gray('    (no logs yet)'))
  } else {
    for (const raw of logs.slice(-10)) {
      lines.push('    ' + formatLogLine(raw, w - 6))
    }
  }
  lines.push('')

  // Artifacts
  if (artifacts.length > 0) {
    lines.push(chalk.bold('  Artifacts'))
    for (const a of artifacts) {
      lines.push(
        `    ${chalk.dim(a.agent.padEnd(12))} ${chalk.white(a.kind.padEnd(20))} ${chalk.yellow('×' + a.cnt)}`,
      )
    }
    lines.push('')
  }

  lines.push(hr)
  lines.push(chalk.dim('  Ctrl+C to stop'))

  return lines.join('\n')
}

export function renderDashboard(state: DashboardState): void {
  logUpdate(formatDashboard(state))
}

/**
 * Format a structured plain-text stop/halt report printed when a run finishes
 * or trips a token/duration circuit breaker.
 */
export function formatRunReport(input: RunReportInput): string {
  const lines: string[] = []
  const statusLine = input.haltReason
    ? `HALTED (${input.haltReason})`
    : 'COMPLETED'

  lines.push('')
  lines.push('  ══════════════════════════════════════════════════')
  lines.push(`  wanman Run Report — ${statusLine}`)
  lines.push('  ══════════════════════════════════════════════════')
  lines.push(`  Goal:     ${input.goal}`)
  lines.push(`  Elapsed:  ${formatElapsed(input.elapsedMs)}${input.budget?.maxDurationMs ? ` / ${formatElapsed(input.budget.maxDurationMs)}` : ''}`)

  const totalTokens = input.budget?.totalTokens
    ?? input.agents.reduce((sum, a) => sum + (a.totalTokens ?? 0), 0)
  const budgetStr = input.budget?.tokenBudget ? ` / ${formatTokens(input.budget.tokenBudget)}` : ''
  lines.push(`  Tokens:   ${formatTokens(totalTokens)}${budgetStr}`)

  const done = input.tasks.filter(t => t.status === 'done').length
  lines.push(`  Tasks:    ${done}/${input.tasks.length} done`)

  if (input.agents.length > 0) {
    lines.push('  Agents:')
    for (const a of input.agents) {
      const rt = a.runtime ? `${a.runtime}/${a.model ?? 'default'}` : (a.model ?? 'default')
      const tok = formatTokens(a.totalTokens ?? 0)
      const branch = a.branch ? ` branch=${a.branch}` : ''
      const halt = a.haltedReason ? ` halted=${a.haltedReason}` : ''
      lines.push(`    - ${a.name.padEnd(10)} ${rt.padEnd(28)} ${tok.padEnd(8)} state=${a.state}${branch}${halt}`)
    }
  }

  if (input.branchSummary && input.branchSummary.length > 0) {
    lines.push('  Branches:')
    for (const b of input.branchSummary) {
      const pr = b.prUrl ? ` PR=${b.prUrl}` : ''
      lines.push(`    - ${b.branch}: +${b.ahead} commit(s), ${b.modified} modified file(s)${pr}`)
    }
  } else if (input.worktrees && input.worktrees.length > 0) {
    lines.push('  Worktrees:')
    for (const wt of input.worktrees) {
      lines.push(`    - ${wt.agent}: ${wt.branch} (${wt.path})`)
    }
  }

  lines.push('  ══════════════════════════════════════════════════')
  return lines.join('\n')
}
