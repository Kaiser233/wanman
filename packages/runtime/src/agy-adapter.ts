import { spawn } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { createLogger } from './logger.js';
import type { AgentAdapter, AgentRunEvent, AgentRunHandle, AgentRunOptions } from './agent-adapter.js';

const log = createLogger('agy-adapter');

export type AgyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface NormalizedAgyLine {
  events: AgentRunEvent[];
  sessionId?: string;
  result?: { text: string; isError: boolean };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Normalize reasoning effort values accepted by `agy --effort`. */
export function normalizeAgyEffort(value?: string): AgyEffort | null {
  if (!value) return null;
  switch (value.trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value.trim().toLowerCase() as AgyEffort;
    default:
      return null;
  }
}

/**
 * Resolve the `agy` executable path without requiring `~/.local/bin` on `PATH`
 * when the supervisor runs under a restricted or overridden `$HOME`.
 */
export function resolveAgyBinary(env?: Record<string, string>): string {
  const explicit = env?.['WANMAN_AGY_BIN']?.trim() || process.env['WANMAN_AGY_BIN']?.trim();
  if (explicit) return explicit;

  const binName = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const pathEnv = env?.['PATH'] ?? process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = path.join(trimmed, binName);
    if (isExecutableFile(candidate)) return candidate;
  }

  const homeCandidates = [
    env?.['HOME']?.trim(),
    process.env['HOME']?.trim(),
    os.homedir(),
  ];
  const seenHomes = new Set<string>();
  for (const home of homeCandidates) {
    if (!home || seenHomes.has(home)) continue;
    seenHomes.add(home);
    const candidate = path.join(home, '.local', 'bin', binName);
    if (isExecutableFile(candidate)) return candidate;
  }

  return 'agy';
}

/**
 * Wrap `systemPrompt` and `message` in `<System>`/`<User>` tags because
 * `agy` has no `--system-prompt` CLI flag in headless stream-json mode.
 */
export function buildAgyPrompt(systemPrompt: string, message?: string): string {
  const sys = systemPrompt.trim();
  const task = message?.trim() || 'Start working.';
  if (!sys) return task;
  return `Follow these instructions exactly.\n\n<System>\n${systemPrompt}\n</System>\n\n<User>\n${task}\n</User>`;
}

/** Build `agy` CLI flags for non-interactive `stream-json` execution. */
export function buildAgyArgs(opts: AgentRunOptions): string[] {
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
  ];

  const model = opts.model?.trim();
  if (model && model.toLowerCase() !== 'default') {
    args.push('--model', model);
  }

  const effort = normalizeAgyEffort(
    opts.reasoningEffort ?? opts.env?.['WANMAN_AGY_EFFORT'] ?? process.env['WANMAN_AGY_EFFORT'],
  );
  if (effort) {
    args.push('--effort', effort);
  }

  const resumeSessionId = opts.resumeSessionId?.trim();
  if (resumeSessionId) {
    args.push('--conversation', resumeSessionId);
  }

  return args;
}

/**
 * Normalize one parsed `agy --output-format stream-json` NDJSON object into
 * `AgentRunEvent`s compatible with `AgentProcess` event logging and token tracking.
 */
export function normalizeAgyEvent(raw: Record<string, unknown>): NormalizedAgyLine {
  const eventName = typeof raw['event'] === 'string' ? raw['event'] : undefined;

  if (eventName === 'init') {
    const initObj = asRecord(raw['init']);
    const sessionId = asNonEmptyString(raw['conversation_id']) ?? asNonEmptyString(initObj?.['conversation_id']);
    return {
      events: [{ ...raw, type: 'init' }],
      ...(sessionId ? { sessionId } : {}),
    };
  }

  if (eventName === 'step_update') {
    const stepUpdate = asRecord(raw['step_update']);
    const sessionId = asNonEmptyString(stepUpdate?.['conversation_id']) ?? asNonEmptyString(raw['conversation_id']);
    const event: AgentRunEvent = { ...raw, type: 'step_update' };

    // Only promote ACTIVE tool calls to top-level `tool_name` / `tool_input` so
    // `AgentProcess.registerEventLogger` logs each tool invocation once.
    if (
      stepUpdate?.['step_type'] === 'tool'
      && stepUpdate['state'] === 'ACTIVE'
      && typeof stepUpdate['tool_name'] === 'string'
    ) {
      event['tool_name'] = stepUpdate['tool_name'];
      const toolInfo = asRecord(stepUpdate['tool_info']);
      const params = asRecord(toolInfo?.['parameters']);
      if (params) {
        event['tool_input'] = params;
      }
    }

    return {
      events: [event],
      ...(sessionId ? { sessionId } : {}),
    };
  }

  if (eventName === 'result' || (!eventName && typeof raw['status'] === 'string')) {
    const payload = eventName === 'result' ? (asRecord(raw['result']) ?? raw) : raw;
    const status = typeof payload['status'] === 'string' ? payload['status'] : 'ERROR';
    const isError = status !== 'SUCCESS';
    const durationSeconds = payload['duration_seconds'];
    const durationMs = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
      ? Math.round(durationSeconds * 1000)
      : undefined;
    const stopReason = asNonEmptyString(payload['finished_reason']);
    const sessionId = asNonEmptyString(payload['conversation_id']) ?? asNonEmptyString(raw['conversation_id']);

    const resultEvent: AgentRunEvent = {
      ...raw,
      ...payload,
      type: 'result',
      is_error: isError,
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
    };

    const events: AgentRunEvent[] = [resultEvent];
    if (isError && payload['error']) {
      events.push({ type: 'error', error: payload['error'] });
    }

    const resultText = isError
      ? (asNonEmptyString(payload['error'])
        ?? asNonEmptyString(payload['response'])
        ?? JSON.stringify(payload))
      : (typeof payload['response'] === 'string'
        ? payload['response']
        : (payload['structured_output'] !== undefined
          ? JSON.stringify(payload['structured_output'])
          : JSON.stringify(payload)));

    return {
      events,
      ...(sessionId ? { sessionId } : {}),
      result: { text: resultText, isError },
    };
  }

  const fallbackType = eventName || asNonEmptyString(raw['type']) || 'unknown';
  return {
    events: [{ ...raw, type: fallbackType }],
  };
}

/** Spawn an `agy` subprocess driven via `stream-json` stdin/stdout NDJSON. */
export function spawnAgy(opts: AgentRunOptions): AgentRunHandle {
  const binary = resolveAgyBinary(opts.env);
  const agyArgs = buildAgyArgs(opts);

  const runAsUser = opts.runAsUser;
  const useRunuser = Boolean(runAsUser && process.getuid?.() === 0);
  const cmd = useRunuser ? 'runuser' : binary;
  const args = useRunuser
    ? ['-u', runAsUser!, '--', binary, ...agyArgs]
    : agyArgs;

  const effort = normalizeAgyEffort(
    opts.reasoningEffort ?? opts.env?.['WANMAN_AGY_EFFORT'] ?? process.env['WANMAN_AGY_EFFORT'],
  );

  log.info('spawning', {
    runtime: 'agy',
    cwd: opts.cwd,
    model: opts.model,
    ...(effort ? { effort } : {}),
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    ...(useRunuser ? { runAsUser } : {}),
  });

  const proc = spawn(cmd, args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      SHELL: '/bin/bash',
      ...(useRunuser ? { HOME: `/home/${runAsUser}` } : {}),
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      AGY_CLI_HIDE_LOGO: 'true',
      DISABLE_TELEMETRY: '1',
      ...opts.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const eventHandlers: Array<(event: AgentRunEvent) => void> = [];
  const resultHandlers: Array<(result: string, isError: boolean) => void> = [];
  const sessionIdHandlers: Array<(sessionId: string) => void> = [];
  const exitHandlers: Array<(code: number) => void> = [];
  let observedSessionId: string | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let rl: ReadlineInterface | null = null;

  const clearKillTimer = (): void => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  };

  if (proc.stdout) {
    rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const raw = JSON.parse(trimmed) as unknown;
        const rawObj = asRecord(raw);
        if (!rawObj) return;

        const normalized = normalizeAgyEvent(rawObj);
        for (const event of normalized.events) {
          for (const handler of eventHandlers) handler(event);
        }

        if (normalized.sessionId && observedSessionId !== normalized.sessionId) {
          observedSessionId = normalized.sessionId;
          for (const handler of sessionIdHandlers) handler(normalized.sessionId);
        }

        if (normalized.result) {
          for (const handler of resultHandlers) {
            handler(normalized.result.text, normalized.result.isError);
          }
        }
      } catch {
        // Skip non-JSON diagnostic lines on stdout.
      }
    });
  }

  if (proc.stderr) {
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) log.warn('stderr', { text: text.slice(0, 500) });
    });
  }

  proc.stdin?.on('error', (err) => {
    log.warn('stdin error', { error: err.message });
  });

  proc.on('error', (err) => {
    clearKillTimer();
    log.error('spawn error', { error: err.message });
    for (const handler of exitHandlers) handler(1);
  });

  proc.on('close', (code) => {
    clearKillTimer();
    rl?.close();
    const exitCode = code ?? 1;
    log.info('exited', { code: exitCode });
    for (const handler of exitHandlers) handler(exitCode);
  });

  const handle: AgentRunHandle = {
    proc,

    sendMessage(content: string): void {
      if (!proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
        log.warn('stdin not writable, cannot send message');
        return;
      }
      const msg = JSON.stringify({
        event: 'user',
        message: { content },
      });
      proc.stdin.write(msg + '\n');
    },

    kill(): void {
      if (!proc.killed) {
        log.info('killing process');
        proc.kill('SIGTERM');
        clearKillTimer();
        killTimer = setTimeout(() => {
          killTimer = null;
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
        killTimer.unref?.();
      }
    },

    wait(): Promise<number> {
      return new Promise((resolve) => {
        if (proc.exitCode !== null) {
          resolve(proc.exitCode);
          return;
        }
        let settled = false;
        const settle = (code: number): void => {
          if (settled) return;
          settled = true;
          resolve(code);
        };
        proc.on('close', (code) => settle(code ?? 1));
        proc.on('error', () => settle(1));
      });
    },

    onEvent(handler) {
      eventHandlers.push(handler);
    },

    onResult(handler) {
      resultHandlers.push(handler);
    },

    onSessionId(handler) {
      sessionIdHandlers.push(handler);
      if (observedSessionId) handler(observedSessionId);
    },

    onExit(handler) {
      exitHandlers.push(handler);
    },

    resumeMissed(): boolean {
      // Missing --conversation IDs emit a stderr warning and execute a fresh
      // conversation automatically; returning false avoids double-execution.
      return false;
    },
  };

  if (opts.initialMessage && opts.initialMessage.trim()) {
    handle.sendMessage(buildAgyPrompt(opts.systemPrompt, opts.initialMessage));
  }

  return handle;
}

export class AgyAdapter implements AgentAdapter {
  readonly runtime = 'agy' as const;

  startRun(opts: AgentRunOptions): AgentRunHandle {
    return spawnAgy(opts);
  }
}
