import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from './logger.js'

const log = createLogger('shared-skill-manager')

/**
 * Resolve the on-disk root for materialized skill-activation snapshots.
 *
 * Resolution order:
 *   1. Explicit `snapshotsRoot` argument (highest priority — tests/host override).
 *   2. `WANMAN_SKILL_SNAPSHOTS_DIR` env var.
 *   3. Sibling of `sharedSkillsDir` (e.g. `<parent>/skill-snapshots` next to
 *      `<parent>/shared-skills`) iff that sibling is writable by the
 *      current process.
 *   4. `${os.tmpdir()}/wanman-skill-snapshots` — always writable.
 */
function resolveSnapshotsRoot(sharedSkillsDir: string, explicit?: string): string {
  if (explicit) return explicit
  const envOverride = process.env['WANMAN_SKILL_SNAPSHOTS_DIR']
  if (envOverride) return envOverride

  const sibling = path.join(path.dirname(sharedSkillsDir), 'skill-snapshots')
  try {
    fs.mkdirSync(sibling, { recursive: true })
    return sibling
  } catch (err) {
    const fallback = path.join(os.tmpdir(), 'wanman-skill-snapshots')
    log.warn('falling back to tmpdir for skill snapshots', {
      sibling,
      fallback,
      reason: err instanceof Error ? err.message : String(err),
    })
    return fallback
  }
}

export type ActivationScope = 'task' | 'loop' | 'run'
export type SharedSkillSource = 'builtin' | 'project' | 'candidate'

export interface ResolvedSharedSkill {
  skillName: string
  version: number
  path: string
  source: SharedSkillSource
}

export interface ActivationSnapshotRecord {
  id: string
  runId: string
  loopNumber?: number
  taskId?: string
  agent: string
  executionProfile?: string
  bundleId?: string
  bundleVersion?: number
  activationScope: ActivationScope
  materializedPath: string
  resolvedSkills: ResolvedSharedSkill[]
}

interface FilesystemSkill {
  name: string
  dir: string
  content: string
}

export class SharedSkillManager {
  private readonly sharedSkillsDir: string
  private readonly snapshotsRoot: string

  constructor(sharedSkillsDir: string, snapshotsRoot?: string) {
    this.sharedSkillsDir = sharedSkillsDir
    this.snapshotsRoot = resolveSnapshotsRoot(sharedSkillsDir, snapshotsRoot)
  }

  listFilesystemSkills(): FilesystemSkill[] {
    if (!fs.existsSync(this.sharedSkillsDir)) {
      return []
    }

    const skills: FilesystemSkill[] = []
    for (const entry of fs.readdirSync(this.sharedSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.sharedSkillsDir, entry.name)
      const skillPath = path.join(dir, 'SKILL.md')
      if (!fs.existsSync(skillPath)) continue
      skills.push({
        name: entry.name,
        dir,
        content: fs.readFileSync(skillPath, 'utf-8'),
      })
    }

    return skills.sort((left, right) => left.name.localeCompare(right.name))
  }

  verifyActivationInfrastructure(): void {
    fs.mkdirSync(this.snapshotsRoot, { recursive: true })

    const sampleSkill = this.listFilesystemSkills()[0]
    if (!sampleSkill) {
      return
    }

    const probeRoot = path.join(this.snapshotsRoot, `.probe-${randomUUID()}`)
    try {
      fs.mkdirSync(probeRoot, { recursive: true })
      fs.cpSync(sampleSkill.dir, path.join(probeRoot, sampleSkill.name), { recursive: true })
    } finally {
      fs.rmSync(probeRoot, { recursive: true, force: true })
    }
  }

  async createActivationSnapshot(input: {
    runId: string
    loopNumber?: number
    taskId?: string
    agent: string
    executionProfile?: string
    bundleId?: string
    bundleVersion?: number
    activationScope: ActivationScope
    activatedBy?: 'human' | 'ceo' | 'optimizer' | 'system'
  }): Promise<ActivationSnapshotRecord | null> {
    const skills = this.listFilesystemSkills()
    if (skills.length === 0) {
      return null
    }

    const id = `snapshot-${randomUUID()}`
    const materializedPath = path.join(this.snapshotsRoot, id)
    fs.mkdirSync(materializedPath, { recursive: true })

    const resolvedSkills: ResolvedSharedSkill[] = []
    for (const skill of skills) {
      const skillDir = path.join(materializedPath, skill.name)
      fs.cpSync(skill.dir, skillDir, { recursive: true })
      resolvedSkills.push({
        skillName: skill.name,
        version: 1,
        path: path.join(skillDir, 'SKILL.md'),
        source: 'builtin',
      })
    }

    log.info('materialized activation snapshot', {
      agent: input.agent,
      snapshotId: id,
      activationScope: input.activationScope,
      taskId: input.taskId,
      executionProfile: input.executionProfile,
      skillCount: resolvedSkills.length,
    })

    return {
      id,
      runId: input.runId,
      loopNumber: input.loopNumber,
      taskId: input.taskId,
      agent: input.agent,
      executionProfile: input.executionProfile,
      bundleId: input.bundleId,
      bundleVersion: input.bundleVersion,
      activationScope: input.activationScope,
      materializedPath,
      resolvedSkills,
    }
  }

  cleanupSnapshots(snapshots: Iterable<ActivationSnapshotRecord>): void {
    for (const snapshot of snapshots) {
      fs.rmSync(snapshot.materializedPath, { recursive: true, force: true })
    }
  }
}
