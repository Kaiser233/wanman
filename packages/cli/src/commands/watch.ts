/**
 * `wanman watch` — Local loop event observer (NDJSON).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

interface WatchOptions {
  /** Path to NDJSON file */
  file?: string
  /** Agent name filter */
  agent?: string
  /** Event type filter */
  type?: string
  /** Only show this classification */
  classification?: string
  /** Show last N events */
  tail: number
}

interface LoopEventRecord {
  type: string
  runId: string
  loop: number
  classification?: string
  agent?: string
  timestamp: string
  [key: string]: unknown
}

function parseArgs(args: string[]): WatchOptions {
  const opts: WatchOptions = { tail: 20 }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file': opts.file = args[++i]; break
      case '--agent': opts.agent = args[++i]; break
      case '--type': opts.type = args[++i]; break
      case '--classification': opts.classification = args[++i]; break
      case '--tail': opts.tail = parseInt(args[++i]!, 10); break
    }
  }

  return opts
}

function formatEvent(event: LoopEventRecord): string {
  const ts = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '??:??:??'
  const loop = String(event.loop ?? '?').padStart(4)
  const type = event.type.padEnd(18)

  switch (event.type) {
    case 'loop.tick':
      return `${ts}  L${loop}  ${type}`
    case 'loop.classified': {
      const cls = (event.classification || '?').padEnd(14)
      const reasons = Array.isArray(event.reasons) ? event.reasons.join('; ') : ''
      const emoji = classificationEmoji(event.classification || '')
      return `${ts}  L${loop}  ${type}  ${emoji} ${cls}  ${reasons}`
    }
    case 'agent.spawned':
      return `${ts}  L${loop}  ${type}  🚀 ${event.agent} (${event.trigger})`
    case 'task.transition':
      return `${ts}  L${loop}  ${type}  📋 #${event.taskId} ${event.from} → ${event.to}`
    case 'task.blocked':
      return `${ts}  L${loop}  ${type}  🚫 #${event.taskId} waiting on [${(event.waitingOn as number[])?.join(',')}]`
    case 'queue.backlog':
      return `${ts}  L${loop}  ${type}  📬 ${event.agent}: ${event.pendingMessages} pending`
    case 'artifact.created':
      return `${ts}  L${loop}  ${type}  📦 ${event.agent}/${event.kind}${event.path ? ` → ${event.path}` : ''}`
    case 'agent.budget_exceeded':
      return `${ts}  L${loop}  ${type}  ⛔ ${event.agent} exceeded token budget (${event.tokens}/${event.budget})`
    case 'run.halted':
      return `${ts}  L${loop}  ${type}  ⛔ run halted (${event.reason})`
    default:
      return `${ts}  L${loop}  ${type}  ${JSON.stringify(event).slice(0, 80)}`
  }
}

function classificationEmoji(c: string): string {
  switch (c) {
    case 'productive': return '✅'
    case 'idle': return '💤'
    case 'blocked': return '🚫'
    case 'backlog_stuck': return '📬'
    case 'error': return '❌'
    default: return '❓'
  }
}

function filterEvent(event: LoopEventRecord, opts: WatchOptions): boolean {
  if (opts.agent && event.agent !== opts.agent) return false
  if (opts.type && event.type !== opts.type) return false
  if (opts.classification && event.type === 'loop.classified' && event.classification !== opts.classification) return false
  if (opts.classification && event.type !== 'loop.classified') return false
  return true
}

/** Read NDJSON file and display events */
export function watchFile(filePath: string, opts: WatchOptions): void {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }

  const content = fs.readFileSync(filePath, 'utf-8').trim()
  if (!content) {
    console.log('No events yet.')
    return
  }

  const lines = content.split('\n')
  const events = lines
    .map(line => { try { return JSON.parse(line) as LoopEventRecord } catch { return null } })
    .filter((e): e is LoopEventRecord => e !== null)
    .filter(e => filterEvent(e, opts))

  const display = events.slice(-opts.tail)

  console.log(`wanman watch — ${display.length} events (of ${events.length} total)`)
  console.log('─'.repeat(80))
  for (const e of display) {
    console.log(formatEvent(e))
  }

  const classified = events.filter(e => e.type === 'loop.classified')
  if (classified.length > 0) {
    const counts: Record<string, number> = {}
    for (const e of classified) {
      const c = e.classification || 'unknown'
      counts[c] = (counts[c] || 0) + 1
    }
    const total = classified.length
    const productive = counts['productive'] || 0
    const rate = Math.round((productive / total) * 100)
    console.log('─'.repeat(80))
    console.log(
      `Summary: ${total} loops | ${productive} productive (${rate}%) | ${counts['idle'] || 0} idle | ${counts['blocked'] || 0} blocked | ${counts['backlog_stuck'] || 0} backlog_stuck | ${counts['error'] || 0} error`,
    )
  }
}

const WATCH_HELP = `wanman watch — Local loop event observer

Usage:
  wanman watch [options]

Options:
  --file <path>          Path to loop-events.ndjson (default: ./deliverables/loop-events.ndjson)
  --agent <name>         Filter by agent name
  --type <event_type>    Filter by event type (loop.tick, loop.classified, agent.spawned, etc.)
  --classification <c>   Filter classified events (productive, idle, blocked, backlog_stuck, error)
  --tail <n>             Show last N events (default: 20)
`

export async function watchCommand(args: string[]): Promise<void> {
  if (args.includes('--help')) {
    console.log(WATCH_HELP)
    return
  }

  const opts = parseArgs(args)
  const file = opts.file || path.join(process.cwd(), 'deliverables', 'loop-events.ndjson')
  watchFile(file, opts)
}
