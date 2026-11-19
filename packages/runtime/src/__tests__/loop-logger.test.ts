import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}))

import { LoopLogger, RingBuffer } from '../loop-logger.js'
import { LoopEventBus } from '../loop-event-bus.js'

describe('RingBuffer', () => {
  it('should push and retrieve items', () => {
    const buf = new RingBuffer<number>(5)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    expect(buf.toArray()).toEqual([1, 2, 3])
    expect(buf.size).toBe(3)
  })

  it('should wrap around when capacity is exceeded', () => {
    const buf = new RingBuffer<number>(3)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    buf.push(4)
    expect(buf.toArray()).toEqual([2, 3, 4])
    expect(buf.size).toBe(3)
  })

  it('should handle empty buffer', () => {
    const buf = new RingBuffer<number>(5)
    expect(buf.toArray()).toEqual([])
    expect(buf.size).toBe(0)
  })

  it('should handle capacity of 1', () => {
    const buf = new RingBuffer<string>(1)
    buf.push('a')
    expect(buf.toArray()).toEqual(['a'])
    buf.push('b')
    expect(buf.toArray()).toEqual(['b'])
    expect(buf.size).toBe(1)
  })
})

describe('LoopLogger', () => {
  let tmpDir: string
  let ndjsonPath: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `loop-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    ndjsonPath = join(tmpDir, 'loop-events.ndjson')
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('writes events to NDJSON file and results.tsv', () => {
    const bus = new LoopEventBus('run-001')
    const logger = new LoopLogger({ ndjsonPath })
    logger.attach(bus)

    bus.tick()
    logger.updateTaskSnapshot(4, 2)
    bus.classify([])

    expect(existsSync(ndjsonPath)).toBe(true)
    const lines = readFileSync(ndjsonPath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).type).toBe('loop.tick')
    expect(JSON.parse(lines[1]!).type).toBe('loop.classified')

    const tsvPath = join(tmpDir, 'results.tsv')
    expect(existsSync(tsvPath)).toBe(true)
    const tsv = readFileSync(tsvPath, 'utf-8')
    expect(tsv).toContain('run-001')
    expect(tsv).toContain('50%')

    logger.detach(bus)
  })

  it('keeps recent events in ring buffer', () => {
    const bus = new LoopEventBus('run-001')
    const logger = new LoopLogger({ ndjsonPath, bufferCapacity: 2 })
    logger.attach(bus)

    bus.tick()
    bus.tick()
    bus.tick()

    const recent = logger.recentEvents()
    expect(recent).toHaveLength(2)
    expect((recent[0] as { loop: number }).loop).toBe(2)
    expect((recent[1] as { loop: number }).loop).toBe(3)

    logger.detach(bus)
  })

  it('stops receiving events after detach', () => {
    const bus = new LoopEventBus('run-001')
    const logger = new LoopLogger({ ndjsonPath })
    logger.attach(bus)

    bus.tick()
    logger.detach(bus)
    bus.tick()

    const lines = readFileSync(ndjsonPath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
  })

  describe('external HTTP hook', () => {
    it('POSTs to hookUrl on loop.classified events only', async () => {
      const fetchCalls: Array<{ url: string; body: string }> = []
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, body: init.body as string })
        return { ok: true, status: 200 }
      }))

      const bus = new LoopEventBus('run-001')
      const logger = new LoopLogger({
        ndjsonPath,
        hookUrl: 'http://localhost:9999/hook',
      })
      logger.attach(bus)

      bus.tick()
      bus.classify([])

      await new Promise(r => setTimeout(r, 50))

      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0]!.url).toBe('http://localhost:9999/hook')
      const payload = JSON.parse(fetchCalls[0]!.body)
      expect(payload.type).toBe('loop.classified')

      logger.detach(bus)
      vi.unstubAllGlobals()
    })

    it('reads hookUrl from WANMAN_LOOP_HOOK env', async () => {
      const origEnv = process.env['WANMAN_LOOP_HOOK']
      process.env['WANMAN_LOOP_HOOK'] = 'http://env-hook:8080/events'

      const fetchCalls: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        fetchCalls.push(url)
        return { ok: true }
      }))

      const bus = new LoopEventBus('run-001')
      const logger = new LoopLogger({ ndjsonPath })
      logger.attach(bus)

      bus.tick()
      bus.classify([])

      await new Promise(r => setTimeout(r, 50))

      expect(fetchCalls[0]).toBe('http://env-hook:8080/events')

      logger.detach(bus)
      vi.unstubAllGlobals()
      if (origEnv === undefined) delete process.env['WANMAN_LOOP_HOOK']
      else process.env['WANMAN_LOOP_HOOK'] = origEnv
    })
  })
})
