import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  buildRunId,
  createRunSessionPlan,
  createRunLaunchPlan,
  detectRequiredRuntimes,
  getRunSourceLabel,
  normalizeRuntime,
  resolveRequestedProjectDir,
} from './run-orchestrator.js'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
  }
})

const mockExistsSync = vi.mocked(fs.existsSync)
const mockStatSync = vi.mocked(fs.statSync)

describe('run orchestrator helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('validates and resolves the requested project directory', () => {
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats)

    const result = resolveRequestedProjectDir('./tmp/project')

    expect(result).toBe(path.resolve('./tmp/project'))
  })

  it('derives launch defaults for the local git root', () => {
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats)

    const plan = createRunLaunchPlan(
      { projectDir: './tmp/project' },
      { projectDir: '/tmp/overlay' },
    )

    expect(plan.requestedProjectDir).toBe(path.resolve('./tmp/project'))
    expect(plan.projectDir).toBe('/tmp/overlay')
    expect(plan.repoSourceDir).toBe(path.resolve('./tmp/project'))
    expect(plan.localGitRoot).toBe(path.resolve('./tmp/project'))
  })

  it('respects explicit git root and repo source overrides', () => {
    const plan = createRunLaunchPlan(
      { projectDir: undefined },
      {
        repoSourceDir: '/tmp/source',
        gitRoot: '/tmp/source',
      },
    )

    expect(plan.repoSourceDir).toBe('/tmp/source')
    expect(plan.localGitRoot).toBe('/tmp/source')
  })

  it('describes the resolved run source consistently', () => {
    expect(getRunSourceLabel({ projectDir: '/tmp/overlay', requestedProjectDir: '/tmp/source' }, { standalone: false })).toBe('project (overlay)')
    expect(getRunSourceLabel({ projectDir: undefined, requestedProjectDir: '/tmp/source' }, { standalone: false })).toBe('working dir (source)')
    expect(getRunSourceLabel({ projectDir: undefined, requestedProjectDir: undefined }, { standalone: true })).toBe('standalone')
    expect(getRunSourceLabel({ projectDir: undefined, requestedProjectDir: undefined }, { standalone: false })).toBe('monorepo')
  })

  it('builds a run session plan from launch context and environment', () => {
    const plan = createRunSessionPlan({
      goal: 'Launch the moonshot beta',
      opts: {
        runtime: undefined,
        codexModel: undefined,
        codexReasoningEffort: undefined,
        workerUrl: undefined,
      },
      launchPlan: {
        projectDir: '/tmp/overlay',
        requestedProjectDir: '/tmp/source',
      },
      configName: 'agents.json (project)',
      configText: JSON.stringify({
        agents: [
          { name: 'ceo', lifecycle: '24/7', runtime: 'codex' },
        ],
      }),
      standalone: false,
      env: {
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        WANMAN_CODEX_MODEL: 'gpt-5.4',
      },
    })

    expect(plan.configName).toBe('agents.json (project)')
    expect(plan.sourceLabel).toBe('project (overlay)')
    expect(plan.useThirdPartyApi).toBe(true)
    expect(plan.useHybrid).toBe(false)
    expect(plan.requiredRuntimes).toEqual(['codex'])
    expect(plan.runtimeLabel).toBe('codex')
    expect(plan.llmModeLabel).toBe('codex-cli')
    expect(plan.codexConfigLabel).toBe('gpt-5.4 / default')
    expect(plan.runId).toMatch(/^run-/)
  })

  it('generates stable run ids from goals', () => {
    expect(buildRunId('Launch beta now')).toMatch(/^wanman-run-/)
  })

  it('normalizes agy runtime aliases and detects agy and mixed runtimes', () => {
    expect(normalizeRuntime('agy')).toBe('agy')
    expect(normalizeRuntime('atg')).toBe('agy')
    expect(normalizeRuntime('antigravity')).toBe('agy')
    expect(normalizeRuntime('codex')).toBe('codex')
    expect(normalizeRuntime('claude')).toBe('claude')
    expect(normalizeRuntime('other')).toBe('agy')

    const agyPlan = createRunSessionPlan({
      goal: 'Run with agy',
      opts: {
        runtime: undefined,
        codexModel: undefined,
        codexReasoningEffort: undefined,
        agyModel: 'gemini-3.8-flash-low',
        agyEffort: 'max',
        workerUrl: undefined,
      },
      launchPlan: { projectDir: undefined, requestedProjectDir: undefined },
      configName: 'agents.json',
      configText: JSON.stringify({ agents: [{ name: 'ceo', runtime: 'antigravity' }] }),
      standalone: true,
      env: {},
    })
    expect(agyPlan.requiredRuntimes).toEqual(['agy'])
    expect(agyPlan.runtimeLabel).toBe('agy')
    expect(agyPlan.llmModeLabel).toBe('agy-cli')
    expect(agyPlan.codexConfigLabel).toBeNull()
    expect(agyPlan.agyConfigLabel).toBe('gemini-3.8-flash-low / max')

    const envOverridePlan = createRunSessionPlan({
      goal: 'Override with atg',
      opts: { runtime: undefined, codexModel: undefined, codexReasoningEffort: undefined, workerUrl: undefined },
      launchPlan: { projectDir: undefined, requestedProjectDir: undefined },
      configName: 'agents.json',
      configText: JSON.stringify({ agents: [{ name: 'ceo', runtime: 'claude' }] }),
      standalone: true,
      env: { WANMAN_RUNTIME: 'atg', WANMAN_AGY_MODEL: 'gemini-4-hydrogen-xhigh', WANMAN_AGY_EFFORT: 'high' },
    })
    expect(envOverridePlan.runtimeOverride).toBe('agy')
    expect(envOverridePlan.requiredRuntimes).toEqual(['agy'])
    expect(envOverridePlan.llmModeLabel).toBe('agy-cli')
    expect(envOverridePlan.agyConfigLabel).toBe('gemini-4-hydrogen-xhigh / high')

    const mixedPlan = createRunSessionPlan({
      goal: 'Mixed runtimes',
      opts: { runtime: undefined, codexModel: undefined, codexReasoningEffort: undefined, workerUrl: undefined },
      launchPlan: { projectDir: undefined, requestedProjectDir: undefined },
      configName: 'agents.json',
      configText: JSON.stringify({
        agents: [
          { name: 'ceo', runtime: 'agy' },
          { name: 'dev', runtime: 'codex' },
        ],
      }),
      standalone: true,
      env: {},
    })
    expect(mixedPlan.requiredRuntimes).toEqual(['agy', 'codex'])
    expect(mixedPlan.llmModeLabel).toBe('multi-runtime')
    expect(mixedPlan.agyConfigLabel).toBe('default / default')
    expect(mixedPlan.codexConfigLabel).toBe('default / default')
    expect(detectRequiredRuntimes('invalid-json')).toEqual(['agy'])
  })
})
