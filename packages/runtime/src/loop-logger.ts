/**
 * LoopLogger — local persistence for loop events (NDJSON + results.tsv + optional HTTP hook).
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LoopEventBus } from './loop-event-bus.js'
import type { LoopEvent } from './loop-events.js'
import { createLogger } from './logger.js'

const log = createLogger('loop-logger')

/** Ring buffer: keeps last N events in memory */
export class RingBuffer<T> {
  private buffer: (T | undefined)[]
  private head = 0
  private _size = 0

  constructor(readonly capacity: number) {
    this.buffer = new Array(capacity)
  }

  push(item: T): void {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    if (this._size < this.capacity) this._size++
  }

  get size(): number { return this._size }

  /** Return items from oldest to newest */
  toArray(): T[] {
    if (this._size === 0) return []
    const result: T[] = []
    const start = this._size < this.capacity ? 0 : this.head
    for (let i = 0; i < this._size; i++) {
      const idx = (start + i) % this.capacity
      result.push(this.buffer[idx] as T)
    }
    return result
  }
}

export interface LoopLoggerOptions {
  /** Path to NDJSON output file */
  ndjsonPath: string
  /** Ring buffer capacity (default: 1000) */
  bufferCapacity?: number
  /** External HTTP hook URL (env: WANMAN_LOOP_HOOK). POST JSON on each loop.classified event. */
  hookUrl?: string
}

export class LoopLogger {
  private ndjsonPath: string
  private tsvPath: string
  private ringBuffer: RingBuffer<LoopEvent>
  private hookUrl: string | null
  private listener: ((event: LoopEvent) => void) | null = null

  constructor(options: LoopLoggerOptions) {
    this.ndjsonPath = options.ndjsonPath
    this.tsvPath = join(dirname(options.ndjsonPath), 'results.tsv')
    this.ringBuffer = new RingBuffer(options.bufferCapacity ?? 1000)
    this.hookUrl = options.hookUrl ?? process.env['WANMAN_LOOP_HOOK'] ?? null

    mkdirSync(dirname(this.ndjsonPath), { recursive: true })
  }

  /** Subscribe to an event bus and start logging */
  attach(bus: LoopEventBus): void {
    this.listener = (event: LoopEvent) => this.handleEvent(event, bus.runId)
    bus.on(this.listener)
  }

  /** Unsubscribe from the event bus */
  detach(bus: LoopEventBus): void {
    if (this.listener) {
      bus.off(this.listener)
      this.listener = null
    }
  }

  /** Get recent events from the ring buffer */
  recentEvents(): LoopEvent[] {
    return this.ringBuffer.toArray()
  }

  private handleEvent(event: LoopEvent, runId: string): void {
    this.ringBuffer.push(event)

    try {
      appendFileSync(this.ndjsonPath, JSON.stringify(event) + '\n')
    } catch (err) {
      log.error('NDJSON write failed', { error: String(err) })
    }

    if (event.type === 'loop.classified') {
      try {
        this.appendTsv(event as LoopEvent & { classification: string; reasons: string[]; loop: number }, runId)
      } catch (err) {
        log.warn('results.tsv write failed', { error: String(err) })
      }
    }

    if (this.hookUrl && event.type === 'loop.classified') {
      this.postHook(event).catch(err => {
        log.warn('loop hook POST failed', { url: this.hookUrl, error: String(err) })
      })
    }
  }

  private appendTsv(event: { classification: string; reasons: string[]; loop: number; runId: string; timestamp: string }, runId: string): void {
    if (!existsSync(this.tsvPath)) {
      appendFileSync(this.tsvPath, 'run_id\tloop\tclassification\ttasks_created\ttasks_done\tcompletion_rate\treasons\ttimestamp\n')
    }
    const reasons = event.reasons.join('; ').replace(/\t/g, ' ')
    const tc = this._taskSnapshot.created
    const td = this._taskSnapshot.done
    const rate = tc > 0 ? Math.round((td / tc) * 100) : 0
    appendFileSync(this.tsvPath, `${runId}\t${event.loop}\t${event.classification}\t${tc}\t${td}\t${rate}%\t${reasons}\t${event.timestamp}\n`)
  }

  private _taskSnapshot = { created: 0, done: 0 }

  updateTaskSnapshot(created: number, done: number): void {
    this._taskSnapshot = { created, done }
  }

  private async postHook(event: LoopEvent): Promise<void> {
    const resp = await fetch(this.hookUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    })
    if (!resp.ok) {
      log.warn('loop hook returned non-OK', { status: resp.status })
    }
  }
}
