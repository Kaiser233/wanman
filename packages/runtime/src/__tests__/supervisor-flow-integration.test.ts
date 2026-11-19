/**
 * Integration tests for multi-step flows through Supervisor.
 * Verifies local SQLite & Git component interactions end-to-end:
 * - Task done → git auto-commit
 * - Artifact put → list → get (local SQLite content round-trip & filtering)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { JsonRpcRequest } from '@wanman/core'
import { RPC_METHODS } from '@wanman/core'

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn<(cmd: string, ...rest: unknown[]) => string | Buffer>(),
}))
vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}))

vi.mock('../http-server.js', () => ({
  createHttpServer: vi.fn(() => ({
    close: (cb: () => void) => cb(),
  })),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../agent-process.js', () => {
  class MockAgentProcess {
    definition: unknown
    state = 'idle'
    constructor(def: unknown) { this.definition = def }
    async start() {}
    stop() {}
    handleSteer() {}
  }
  return { AgentProcess: MockAgentProcess }
})

import { Supervisor } from '../supervisor.js'

function rpc(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id: 1, method, params }
}

describe('Supervisor flow integration', () => {
  let supervisor: Supervisor

  beforeEach(async () => {
    vi.clearAllMocks()
    mockExecSync.mockReturnValue('')

    supervisor = new Supervisor({
      agents: [
        { name: 'dev', lifecycle: '24/7', model: 'standard', systemPrompt: 'dev' },
        { name: 'marketing', lifecycle: 'on-demand', model: 'fast', systemPrompt: 'marketing' },
      ],
      dbPath: ':memory:',
      port: 0,
    })
    await supervisor.start()
    mockExecSync.mockClear()
  })

  afterEach(async () => {
    await supervisor.shutdown()
  })

  describe('task done triggers git auto-commit', () => {
    it('should call gitAutoCommit when task is marked done via RPC', async () => {
      const createRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_CREATE, {
        title: 'Build website',
        assignee: 'dev',
        priority: 3,
      }))
      expect(createRes.error).toBeUndefined()
      const task = createRes.result as { id: string }

      mockExecSync.mockImplementation((cmd: string) => {
        if (String(cmd) === 'git status --porcelain') return 'M agents/dev/output/website/index.html'
        if (String(cmd).startsWith('git diff --cached')) return 'agents/dev/output/website/index.html'
        if (String(cmd).startsWith('git rev-parse --short')) return 'abc1234'
        return ''
      })

      const updateRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_UPDATE, {
        id: task.id,
        status: 'done',
        result: 'Website built successfully',
      }))
      expect(updateRes.error).toBeUndefined()

      const cmds = mockExecSync.mock.calls.map(c => String(c[0]))
      expect(cmds).toContain('git status --porcelain')
      const commitCmd = cmds.find(c => c.startsWith('git commit'))
      expect(commitCmd).toBeDefined()
      expect(commitCmd).toContain('dev: Build website')
      expect(commitCmd).toContain('--author="dev-agent <dev@wanman.dev>"')
    })

    it('should NOT trigger git auto-commit for non-done status updates', async () => {
      const createRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_CREATE, {
        title: 'Some task',
        assignee: 'dev',
      }))
      const task = createRes.result as { id: string }

      mockExecSync.mockClear()

      await supervisor.handleRpcAsync(rpc(RPC_METHODS.TASK_UPDATE, {
        id: task.id,
        status: 'in_progress',
      }))

      const cmds = mockExecSync.mock.calls.map(c => String(c[0]))
      expect(cmds.filter(c => c.includes('git status'))).toHaveLength(0)
    })
  })

  describe('local SQLite artifact content round-trip', () => {
    it('should store content via put and retrieve it via list and get', async () => {
      const putRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_PUT, {
        kind: 'brand_design',
        agent: 'marketing',
        source: 'agent_output',
        confidence: 0.9,
        path: '/workspace/agents/marketing/output/brand-design.md',
        content: '# Brand Design\n\nName: 雫珈琲 / SHIZUKU COFFEE',
        metadata: { format: 'markdown' },
      }))
      expect(putRes.error).toBeUndefined()
      const created = (putRes.result as Array<{ id: number }>)[0]!
      expect(created.id).toBe(1)

      const listRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_LIST, {}))
      expect(listRes.error).toBeUndefined()
      const items = listRes.result as Array<{ content_length: number; metadata: Record<string, unknown> }>
      expect(items).toHaveLength(1)
      expect(items[0]!.content_length).toBeGreaterThan(0)
      expect(items[0]!.metadata['source']).toBe('agent_output')

      const getRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_GET, { id: created.id }))
      expect(getRes.error).toBeUndefined()
      const rows = getRes.result as Array<{ content: string }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.content).toContain('雫珈琲')
    })

    it('should store multiple artifacts and filter by agent and kind', async () => {
      await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_PUT, {
        kind: 'market_data', agent: 'feedback', source: 'web', confidence: 0.7,
        metadata: { item: 'rent' },
      }))
      await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_PUT, {
        kind: 'budget_item', agent: 'finance', source: 'estimate', confidence: 0.5,
        metadata: { item: 'rent' },
      }))

      const allRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_LIST, {}))
      expect((allRes.result as unknown[]).length).toBe(2)

      const feedbackRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_LIST, { agent: 'feedback' }))
      expect((feedbackRes.result as Array<{ agent: string }>).map(a => a.agent)).toEqual(['feedback'])

      const budgetRes = await supervisor.handleRpcAsync(rpc(RPC_METHODS.ARTIFACT_LIST, { kind: 'budget_item' }))
      expect((budgetRes.result as Array<{ kind: string }>).map(a => a.kind)).toEqual(['budget_item'])
    })
  })
})
