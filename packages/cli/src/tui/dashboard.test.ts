import { describe, expect, it, vi } from 'vitest';

vi.mock('log-update', () => ({
  default: vi.fn(),
}));

import { formatDashboard, formatRunReport, renderDashboard } from './dashboard.js';
import logUpdate from 'log-update';

describe('dashboard formatting', () => {
  it('renders empty runtime state', () => {
    const output = formatDashboard({
      goal: 'Ship the first OSS version',
      loop: 0,
      maxLoops: 3,
      elapsed: 12_345,
      agents: [],
      tasks: [],
      logs: [],
      artifacts: [],
    });

    expect(output).toContain('wanman');
    expect(output).toContain('Ship the first OSS version');
    expect(output).toContain('(waiting for health...)');
    expect(output).toContain('(no tasks yet)');
    expect(output).toContain('(no logs yet)');
  });

  it('renders active agents with runtime/model/tool/tokens/branch, budget bar, tasks, logs, and artifacts', () => {
    const output = formatDashboard({
      goal: 'Improve reliability',
      loop: 2,
      maxLoops: 5,
      elapsed: 61_000,
      branchLabel: 'agent/dev',
      budget: {
        totalTokens: 250_000,
        tokenBudget: 1_000_000,
        agentTokenBudget: 0,
        elapsedMs: 61_000,
        maxDurationMs: 3_600_000,
        spawnTimeoutMs: 600_000,
        halted: false,
      },
      agents: [
        {
          name: 'ceo',
          state: 'running',
          lifecycle: '24/7',
          runtime: 'agy',
          model: 'gemini-4-hydrogen-high',
          currentTool: 'Bash',
          totalTokens: 150_000,
        },
        {
          name: 'dev',
          state: 'idle',
          lifecycle: 'on-demand',
          runtime: 'agy',
          model: 'gemini-4-carbon-medium',
          totalTokens: 100_000,
          branch: 'agent/dev',
        },
      ],
      tasks: [
        { id: 'done', title: 'Write release notes', status: 'done', priority: 3 },
        { id: 'active', title: 'Fix local supervisor startup', status: 'in_progress', assignee: 'dev', priority: 1 },
      ],
      logs: [
        JSON.stringify({ ts: '2026-01-01T00:00:00Z', scope: 'supervisor', msg: 'agent spawned', agent: 'dev' }),
        'plain log line',
      ],
      artifacts: [
        { agent: 'marketing', kind: 'brand_asset', cnt: 2 },
      ],
    });

    expect(output).toContain('Git:');
    expect(output).toContain('agent/dev');
    expect(output).toContain('Tokens:');
    expect(output).toContain('250.0k');
    expect(output).toContain('25%');
    expect(output).toContain('agy/gemini-4-hydrogen-high');
    expect(output).toContain('⚙ Bash');
    expect(output).toContain('[agent/dev]');
    expect(output).toContain('ceo');
    expect(output).toContain('dev');
    expect(output.indexOf('Fix local supervisor startup')).toBeLessThan(output.indexOf('Write release notes'));
    expect(output).toContain('agent spawned');
    expect(output).toContain('plain log line');
    expect(output).toContain('marketing');
    expect(output).toContain('brand_asset');
  });

  it('renders circuit breaker halt banner and structured run report', () => {
    const dashboard = formatDashboard({
      goal: 'Overnight refactor',
      loop: 4,
      maxLoops: 10,
      elapsed: 120_000,
      budget: {
        totalTokens: 1_050_000,
        tokenBudget: 1_000_000,
        agentTokenBudget: 0,
        elapsedMs: 120_000,
        maxDurationMs: 3_600_000,
        spawnTimeoutMs: 600_000,
        halted: true,
        haltReason: 'token_budget_exceeded',
      },
      agents: [
        { name: 'dev', state: 'stopped', lifecycle: 'on-demand', haltedReason: 'token_budget_exceeded', branch: 'agent/dev' },
      ],
      tasks: [],
      logs: [],
      artifacts: [],
    });

    expect(dashboard).toContain('CIRCUIT BREAKER HALTED');
    expect(dashboard).toContain('token_budget_exceeded');

    const report = formatRunReport({
      goal: 'Overnight refactor',
      elapsedMs: 120_000,
      haltReason: 'token_budget_exceeded',
      budget: {
        totalTokens: 1_050_000,
        tokenBudget: 1_000_000,
        agentTokenBudget: 0,
        elapsedMs: 120_000,
        maxDurationMs: 3_600_000,
        spawnTimeoutMs: 600_000,
        halted: true,
        haltReason: 'token_budget_exceeded',
      },
      agents: [
        { name: 'dev', state: 'stopped', lifecycle: 'on-demand', runtime: 'agy', model: 'gemini-4-carbon-medium', totalTokens: 1_050_000, branch: 'agent/dev', haltedReason: 'token_budget_exceeded' },
      ],
      tasks: [
        { id: 't1', title: 'Refactor auth', status: 'done', assignee: 'dev' },
      ],
      branchSummary: [
        { branch: 'agent/dev', ahead: 2, modified: 1 },
      ],
    });

    expect(report).toContain('HALTED (token_budget_exceeded)');
    expect(report).toContain('1.05M / 1.00M');
    expect(report).toContain('1/1 done');
    expect(report).toContain('agent/dev: +2 commit(s), 1 modified file(s)');
  });

  it('uses log-update when rendering', () => {
    renderDashboard({
      goal: 'Render once',
      loop: 1,
      maxLoops: 1,
      elapsed: 0,
      agents: [],
      tasks: [],
      logs: [],
      artifacts: [],
    });

    expect(logUpdate).toHaveBeenCalledWith(expect.stringContaining('Render once'));
  });
});
