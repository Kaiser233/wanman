/**
 * `wanman takeover` - Take over an existing git repo with autonomous agents.
 *
 * This command intentionally stays thin:
 * - parse takeover-specific CLI args
 * - scan the project and build the initial agent config
 * - dispatch into the local supervisor path (the only path supported in OSS)
 * - delegate project analysis details to dedicated modules
 */

import * as fs from 'node:fs'
import type { AgentRuntime } from '@wanman/core'
import { normalizeRuntime } from '@wanman/host-sdk'
import {
  type GeneratedAgentConfig,
  type ProjectDocument,
  type ProjectIntent,
  type ProjectProfile,
  buildProjectIntent,
  collectProjectDocs,
  detectCI,
  detectCodeRoots,
  detectFrameworks,
  detectGitHubRemote,
  detectLanguages,
  detectPackageManagers,
  detectPackageScripts,
  detectTests,
  generateAgentConfig,
  inferGoal,
  materializeTakeoverProject,
  scanProject,
  scanReadme,
} from '../takeover-project.js'
import {
  hasLocalProgress,
  materializeLocalTakeoverProject,
  parseLocalGitStatus,
  planLocalDynamicClone,
  runLocal,
} from '../takeover-local.js'
import { parseOptions } from './run.js'

export type {
  GeneratedAgentConfig,
  ProjectDocument,
  ProjectIntent,
  ProjectProfile,
}

export {
  buildProjectIntent,
  collectProjectDocs,
  detectCI,
  detectCodeRoots,
  detectFrameworks,
  detectGitHubRemote,
  detectLanguages,
  detectPackageManagers,
  detectPackageScripts,
  detectTests,
  generateAgentConfig,
  hasLocalProgress,
  inferGoal,
  materializeLocalTakeoverProject,
  materializeTakeoverProject,
  parseLocalGitStatus,
  planLocalDynamicClone,
  scanProject,
  scanReadme,
}

const TAKEOVER_HELP = `wanman takeover - Take over a local git repo with isolated worktrees

Usage:
  wanman takeover <path> [options]

Runs the supervisor + agents locally against the target repo. Each code-writing
worker runs in its own isolated git worktree & branch (agent/<worker>) by default.
Authenticate your CLI runtime ('agy', 'claude login', or 'codex login') first.

Options:
  --goal <text>           Override auto-inferred long-running mission
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
  --no-worktree-isolation Share a single worktree instead of per-worker git worktrees
  --dry-run               Scan and generate takeover overlay without launching
  --infinite              Run in infinite mode (default when --loops is omitted)
  --loops <n>             Run finite observation loops instead of infinite mode
  --poll <seconds>        Poll interval
  --keep                  Keep supervisor alive on exit
  --output <path>         Deliverables directory
`

function splitTakeoverArgs(args: string[]): {
  projectPath: string
  goalOverride?: string
  runtime: AgentRuntime
  dryRun: boolean
  runArgs: string[]
} {
  const projectPath = args[0]!
  const runArgs: string[] = []
  let goalOverride: string | undefined
  let runtime: AgentRuntime = 'agy'
  let dryRun = false

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--goal':
        goalOverride = args[++i]
        break
      case '--runtime':
        runtime = normalizeRuntime(args[++i])
        break
      case '--dry-run':
        dryRun = true
        break
      default:
        runArgs.push(arg!)
        if (arg && arg.startsWith('--') && !['--infinite', '--keep', '--worktree-isolation', '--no-worktree-isolation'].includes(arg)) {
          const next = args[i + 1]
          if (next && !next.startsWith('--')) {
            runArgs.push(next)
            i++
          }
        }
        break
    }
  }

  return { projectPath, goalOverride, runtime, dryRun, runArgs }
}

function hasExplicitRunMode(runArgs: string[]): boolean {
  return runArgs.includes('--infinite') || runArgs.includes('--loops')
}

/** @internal exported for testing */
export function resolveTakeoverRunOptions(goal: string, runArgs: string[]) {
  const normalizedRunArgs = hasExplicitRunMode(runArgs) ? runArgs : ['--infinite', ...runArgs]
  const { opts } = parseOptions([goal, ...normalizedRunArgs])
  // Takeover enables per-worker worktree isolation by default unless opted out.
  if (!runArgs.includes('--no-worktree-isolation') && !runArgs.includes('--worktree-isolation')) {
    opts.worktreeIsolation = true
  }
  return opts
}

function printProjectSummary(profile: ProjectProfile, generated: GeneratedAgentConfig): void {
  console.log('\n  Project Profile:')
  console.log(`    Languages:   ${profile.languages.join(', ') || 'none'}`)
  console.log(`    Frameworks:  ${profile.frameworks.join(', ') || 'none'}`)
  console.log(`    CI/CD:       ${profile.ci.join(', ') || 'none'}`)
  console.log(`    Tests:       ${profile.testFrameworks.join(', ') || 'none'}`)
  console.log(`    Issues:      ${profile.issueTracker}`)
  console.log(`    README:      ${profile.hasReadme ? 'yes' : 'no'}`)
  console.log(`    Docs:        ${profile.hasDocs ? 'yes' : 'no'}`)
  console.log(`    Code Roots:  ${(profile.codeRoots ?? []).join(', ') || 'repo root'}`)

  console.log('\n  Project Intent:')
  console.log(`    Name:        ${generated.intent.projectName}`)
  console.log(`    Summary:     ${generated.intent.summary.slice(0, 120)}`)
  console.log(`    Docs:        ${generated.intent.canonicalDocs.map(doc => doc.path).join(', ') || 'none'}`)
  console.log('    Themes:')
  for (const theme of generated.intent.strategicThemes) {
    console.log(`      - ${theme}`)
  }
}

export async function takeoverCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(TAKEOVER_HELP)
    return
  }

  const { projectPath, goalOverride, runtime, dryRun, runArgs } = splitTakeoverArgs(args)
  if (!fs.existsSync(projectPath)) {
    console.error(`Error: path does not exist: ${projectPath}`)
    process.exit(1)
  }

  console.log(`\n  Scanning ${projectPath}...`)
  const profile = scanProject(projectPath)
  const generated = generateAgentConfig(profile, goalOverride, runtime)
  const previewGoal = generated.goal
  const opts = resolveTakeoverRunOptions(previewGoal, runArgs)
  printProjectSummary(profile, generated)

  const overlayDir = materializeLocalTakeoverProject(profile, generated, {
    worktreeIsolation: opts.worktreeIsolation,
    tokenBudget: opts.maxTokens,
    agentTokenBudget: opts.agentMaxTokens,
    maxDurationMs: opts.maxDurationSec > 0 ? opts.maxDurationSec * 1000 : 0,
    spawnTimeoutMs: opts.spawnTimeoutSec > 0 ? opts.spawnTimeoutSec * 1000 : 0,
  })

  console.log(`\n  Runtime: ${runtime}`)
  console.log(`  Goal: ${generated.goal}`)
  console.log('\n  Agents:')
  for (const agent of generated.agents) {
    const status = agent.enabled ? 'enabled' : 'disabled'
    console.log(`    [${status}] ${agent.name} (${agent.lifecycle}) - ${agent.reason}`)
  }
  console.log(`\n  Overlay: ${overlayDir}`)

  if (dryRun) {
    console.log(`\n  Dry run complete. Generated takeover overlay at ${overlayDir}`)
    return
  }

  await runLocal(profile, generated, overlayDir, opts)
}
