import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logger, spawnMock } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../logger.js', () => ({
  createLogger: () => logger,
}));

import {
  AgyAdapter,
  buildAgyArgs,
  buildAgyPrompt,
  normalizeAgyEffort,
  normalizeAgyEvent,
  resolveAgyBinary,
  spawnAgy,
} from '../agy-adapter.js';
import type { AgentRunEvent, AgentRunOptions } from '../agent-adapter.js';

type MockProc = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

function makeOpts(overrides?: Partial<AgentRunOptions>): AgentRunOptions {
  return {
    runtime: 'agy' as AgentRunOptions['runtime'],
    model: 'gemini-4-carbon-medium',
    systemPrompt: 'System prompt',
    cwd: '/tmp/work',
    ...overrides,
  };
}

async function flushEvents(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('agy-adapter helpers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env['WANMAN_AGY_BIN'];
    delete process.env['WANMAN_AGY_EFFORT'];
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes supported reasoning efforts and rejects unknown values', () => {
    expect(normalizeAgyEffort('LOW')).toBe('low');
    expect(normalizeAgyEffort(' medium ')).toBe('medium');
    expect(normalizeAgyEffort('high')).toBe('high');
    expect(normalizeAgyEffort('xhigh')).toBe('xhigh');
    expect(normalizeAgyEffort('max')).toBe('max');
    expect(normalizeAgyEffort('turbo')).toBeNull();
    expect(normalizeAgyEffort(undefined)).toBeNull();
  });

  it('builds args with stream-json I/O, skipping default/empty model and adding effort & conversation', () => {
    expect(buildAgyArgs(makeOpts({ model: 'default' }))).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ]);

    expect(buildAgyArgs(makeOpts({
      model: 'gemini-4-hydrogen-xhigh',
      reasoningEffort: 'xhigh',
      resumeSessionId: 'conv-123',
    }))).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--model', 'gemini-4-hydrogen-xhigh',
      '--effort', 'xhigh',
      '--conversation', 'conv-123',
    ]);
  });

  it('uses WANMAN_AGY_EFFORT when reasoningEffort is omitted', () => {
    const args = buildAgyArgs(makeOpts({
      env: { WANMAN_AGY_EFFORT: 'high' },
    }));
    expect(args).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--model', 'gemini-4-carbon-medium',
      '--effort', 'high',
    ]);
  });

  it('wraps systemPrompt and message in System/User tags when systemPrompt is present', () => {
    expect(buildAgyPrompt('Be concise.', 'Check tests')).toBe(
      'Follow these instructions exactly.\n\n<System>\nBe concise.\n</System>\n\n<User>\nCheck tests\n</User>',
    );
    expect(buildAgyPrompt('   ', 'Check tests')).toBe('Check tests');
    expect(buildAgyPrompt('Be concise.', '   ')).toBe(
      'Follow these instructions exactly.\n\n<System>\nBe concise.\n</System>\n\n<User>\nStart working.\n</User>',
    );
  });

  it('resolves binary via WANMAN_AGY_BIN, PATH, and HOME/.local/bin fallback', () => {
    expect(resolveAgyBinary({ WANMAN_AGY_BIN: '/custom/agy' })).toBe('/custom/agy');

    process.env['WANMAN_AGY_BIN'] = '/env/agy';
    expect(resolveAgyBinary()).toBe('/env/agy');
    delete process.env['WANMAN_AGY_BIN'];

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bin-'));
    tempDirs.push(dir);
    const binPath = path.join(dir, 'agy');
    fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(binPath, 0o755);

    expect(resolveAgyBinary({ PATH: dir, HOME: '/nonexistent' })).toBe(binPath);

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
    tempDirs.push(homeDir);
    const localBinDir = path.join(homeDir, '.local', 'bin');
    fs.mkdirSync(localBinDir, { recursive: true });
    const homeBin = path.join(localBinDir, 'agy');
    fs.writeFileSync(homeBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(homeBin, 0o755);

    expect(resolveAgyBinary({ PATH: '/nonexistent', HOME: homeDir })).toBe(homeBin);
  });

  it('normalizes init, active/done tool step_update, success result, and error envelopes', () => {
    const initNorm = normalizeAgyEvent({
      event: 'init',
      conversation_id: 'conv-1',
      init: { cwd: '/tmp/work', permission_mode: 'always-proceed' },
    });
    expect(initNorm.sessionId).toBe('conv-1');
    expect(initNorm.events[0]).toMatchObject({ type: 'init', conversation_id: 'conv-1' });

    const activeTool = normalizeAgyEvent({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'read_file',
        tool_info: { name: 'read_file', parameters: { Path: '/tmp/work/hello.txt' } },
      },
    });
    expect(activeTool.events[0]).toMatchObject({
      type: 'step_update',
      tool_name: 'read_file',
      tool_input: { Path: '/tmp/work/hello.txt' },
    });

    const doneTool = normalizeAgyEvent({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'read_file',
        tool_info: { name: 'read_file', parameters: { Path: '/tmp/work/hello.txt' }, output: '1 lines' },
      },
    });
    expect(doneTool.events[0]!['tool_name']).toBeUndefined();
    expect(doneTool.events[0]!['tool_input']).toBeUndefined();

    const successResult = normalizeAgyEvent({
      event: 'result',
      result: {
        conversation_id: 'conv-1',
        status: 'SUCCESS',
        response: 'hello_from_file\n',
        duration_seconds: 1.25,
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 12, cache_read_tokens: 80, total_tokens: 112 },
      },
    });
    expect(successResult.result).toEqual({ text: 'hello_from_file\n', isError: false });
    expect(successResult.events).toEqual([
      expect.objectContaining({
        type: 'result',
        is_error: false,
        duration_ms: 1250,
        usage: { input_tokens: 100, output_tokens: 12, cache_read_tokens: 80, total_tokens: 112 },
      }),
    ]);

    const errorResult = normalizeAgyEvent({
      conversation_id: '',
      status: 'ERROR',
      response: '',
      error: 'invalid model selection',
      finished_reason: 'error',
      duration_seconds: 0,
      num_turns: 0,
    });
    expect(errorResult.result).toEqual({ text: 'invalid model selection', isError: true });
    expect(errorResult.events).toEqual([
      expect.objectContaining({
        type: 'result',
        is_error: true,
        stop_reason: 'error',
        duration_ms: 0,
      }),
      { type: 'error', error: 'invalid model selection' },
    ]);
  });
});

describe('spawnAgy & AgyAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('spawns agy with stream-json flags, safe env defaults, and writes wrapped initialMessage to stdin', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const written: string[] = [];
    proc.stdin.on('data', chunk => written.push(chunk.toString()));

    const adapter = new AgyAdapter();
    expect(adapter.runtime).toBe('agy');

    const handle = adapter.startRun(makeOpts({
      model: 'gemini-3.8-flash-low',
      reasoningEffort: 'low',
      resumeSessionId: 'conv-prev',
      initialMessage: 'Read hello.txt',
      env: {
        WANMAN_AGY_BIN: '/usr/local/bin/agy',
        CUSTOM_VAR: '1',
      },
    }));

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/agy',
      [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--model', 'gemini-3.8-flash-low',
        '--effort', 'low',
        '--conversation', 'conv-prev',
      ],
      expect.objectContaining({
        cwd: '/tmp/work',
        env: expect.objectContaining({
          SHELL: '/bin/bash',
          AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
          AGY_CLI_HIDE_LOGO: 'true',
          DISABLE_TELEMETRY: '1',
          CUSTOM_VAR: '1',
        }),
      }),
    );

    await flushEvents();
    expect(written).toHaveLength(1);
    const line = JSON.parse(written[0]!.trim()) as { event: string; message: { content: string } };
    expect(line.event).toBe('user');
    expect(line.message.content).toContain('<System>\nSystem prompt\n</System>');
    expect(line.message.content).toContain('<User>\nRead hello.txt\n</User>');

    handle.sendMessage('Follow up');
    await flushEvents();
    const followUp = JSON.parse(written[1]!.trim()) as { event: string; message: { content: string } };
    expect(followUp).toEqual({ event: 'user', message: { content: 'Follow up' } });
  });

  it('does not write to stdin when initialMessage is omitted or blank', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const writeSpy = vi.spyOn(proc.stdin, 'write');

    spawnAgy(makeOpts({ initialMessage: undefined }));
    spawnAgy(makeOpts({ initialMessage: '   ' }));

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('uses runuser when running as root with runAsUser set', () => {
    const getuid = process.getuid ? vi.spyOn(process, 'getuid').mockReturnValue(0) : undefined;
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    spawnAgy(makeOpts({
      runAsUser: 'agent',
      env: { WANMAN_AGY_BIN: '/opt/bin/agy' },
    }));

    expect(spawnMock).toHaveBeenCalledWith(
      'runuser',
      expect.arrayContaining(['-u', 'agent', '--', '/opt/bin/agy', '--input-format', 'stream-json']),
      expect.objectContaining({
        env: expect.objectContaining({ HOME: '/home/agent' }),
      }),
    );
    getuid?.mockRestore();
  });

  it('streams events, captures session id (including late subscribers), and emits onResult once per result', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    const handle = spawnAgy(makeOpts({ env: { WANMAN_AGY_BIN: 'agy' } }));
    const events: AgentRunEvent[] = [];
    const results: Array<{ text: string; isError: boolean }> = [];
    const sessionIds: string[] = [];

    handle.onEvent(e => events.push(e));
    handle.onResult((text, isError) => results.push({ text, isError }));
    handle.onSessionId?.(id => sessionIds.push(id));

    proc.stdout.write('not-json-diagnostic\n');
    proc.stdout.write(`${JSON.stringify({
      event: 'init',
      conversation_id: 'uuid-1234',
      init: { cwd: '/tmp/work', permission_mode: 'always-proceed' },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'uuid-1234',
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'uuid-1234',
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' } },
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'uuid-1234',
        status: 'SUCCESS',
        response: 'All good\n',
        duration_seconds: 2.0,
        num_turns: 1,
        usage: { input_tokens: 120, output_tokens: 20, total_tokens: 140 },
      },
    })}\n`);

    await flushEvents();

    const lateSessionIds: string[] = [];
    handle.onSessionId?.(id => lateSessionIds.push(id));

    expect(sessionIds).toEqual(['uuid-1234']);
    expect(lateSessionIds).toEqual(['uuid-1234']);
    expect(results).toEqual([{ text: 'All good\n', isError: false }]);
    expect(events.map(e => e.type)).toEqual(['init', 'step_update', 'step_update', 'result']);
    expect(events[2]).toMatchObject({
      type: 'step_update',
      tool_name: 'run_command',
      tool_input: { CommandLine: 'pwd' },
    });
    expect(events[3]).toMatchObject({
      type: 'result',
      is_error: false,
      duration_ms: 2000,
      usage: { input_tokens: 120, output_tokens: 20, total_tokens: 140 },
    });
  });

  it('emits error event and does not trigger resumeMissed on missing-conversation stderr warnings', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    const handle = spawnAgy(makeOpts({
      resumeSessionId: '00000000-0000-0000-0000-000000000000',
      env: { WANMAN_AGY_BIN: 'agy' },
    }));

    const events: AgentRunEvent[] = [];
    const results: Array<{ text: string; isError: boolean }> = [];
    handle.onEvent(e => events.push(e));
    handle.onResult((text, isError) => results.push({ text, isError }));

    proc.stderr.write('warning: conversation "00000000-0000-0000-0000-000000000000" not found\n');
    proc.stdout.write(`${JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'new-uuid',
        status: 'ERROR',
        response: 'partial',
        error: 'print timeout',
        finished_reason: 'print_timeout',
        duration_seconds: 5.0,
        num_turns: 1,
      },
    })}\n`);

    await flushEvents();

    expect(handle.resumeMissed?.()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('stderr', {
      text: 'warning: conversation "00000000-0000-0000-0000-000000000000" not found',
    });
    expect(results).toEqual([{ text: 'print timeout', isError: true }]);
    expect(events).toEqual([
      expect.objectContaining({ type: 'result', is_error: true, stop_reason: 'print_timeout', duration_ms: 5000 }),
      { type: 'error', error: 'print timeout' },
    ]);
  });

  it('handles wait, onExit, destroyed stdin, and SIGTERM -> SIGKILL escalation', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    proc.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') proc.killed = true;
      return true;
    });
    spawnMock.mockReturnValue(proc);

    const handle = spawnAgy(makeOpts({ env: { WANMAN_AGY_BIN: 'agy' } }));

    proc.stdin.destroy();
    expect(() => handle.sendMessage('ignored')).not.toThrow();

    const exits: number[] = [];
    handle.onExit(code => exits.push(code));

    handle.kill();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    const waitPromise = handle.wait();
    proc.exitCode = 3;
    proc.emit('close', 3);

    await expect(waitPromise).resolves.toBe(3);
    expect(exits).toEqual([3]);
  });
});
