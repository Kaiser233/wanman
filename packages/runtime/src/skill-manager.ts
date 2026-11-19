/**
 * SkillManager — local filesystem skill resolution and in-memory version management.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createLogger } from './logger.js'

const log = createLogger('skill-manager')

export interface SkillVersion {
  id: number
  agent: string
  version: number
  content: string
  isActive: boolean
  evalPassRate: number | null
  createdAt: string
  createdBy: string
}

export interface SkillMetrics {
  agent: string
  runs: number
  successRate: number
  avgDurationMs: number
  avgSteerCount: number
  interventionRate: number
}

export class SkillManager {
  private readonly skillsDir: string
  private readonly versionsByAgent = new Map<string, SkillVersion[]>()
  private nextId = 1

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir
  }

  /**
   * Resolve the active skill content for an agent.
   * Priority: active in-memory override → local filesystem AGENT.md → null
   */
  async resolveSkill(agent: string): Promise<string | null> {
    const versions = this.versionsByAgent.get(agent) ?? []
    const active = versions.find(v => v.isActive)
    if (active) {
      return active.content
    }

    const localPath = path.join(this.skillsDir, agent, 'AGENT.md')
    if (fs.existsSync(localPath)) {
      log.info('resolved skill from file', { agent, source: 'file' })
      return fs.readFileSync(localPath, 'utf-8')
    }

    return null
  }

  /** Get all versions of a skill for an agent (newest first) */
  async getVersions(agent: string): Promise<SkillVersion[]> {
    const versions = this.versionsByAgent.get(agent) ?? []
    return [...versions].sort((a, b) => b.version - a.version)
  }

  /** Create a new skill version (does NOT activate it — use activateVersion for that) */
  async createVersion(agent: string, content: string, createdBy: string = 'human'): Promise<SkillVersion> {
    const existing = this.versionsByAgent.get(agent) ?? []
    const maxVersion = existing.reduce((max, item) => Math.max(max, item.version), 0)
    const entry: SkillVersion = {
      id: this.nextId++,
      agent,
      version: maxVersion + 1,
      content,
      isActive: false,
      evalPassRate: null,
      createdAt: new Date().toISOString(),
      createdBy,
    }
    this.versionsByAgent.set(agent, [...existing, entry])
    return entry
  }

  /** Activate a specific version (deactivates all others for that agent) */
  async activateVersion(agent: string, version: number): Promise<boolean> {
    const existing = this.versionsByAgent.get(agent)
    if (!existing) return false
    const target = existing.find(v => v.version === version)
    if (!target) return false
    for (const item of existing) {
      item.isActive = item.version === version
    }
    log.info('skill version activated', { agent, version })
    return true
  }

  /** Rollback to previous version */
  async rollback(agent: string): Promise<boolean> {
    const versions = await this.getVersions(agent)
    if (versions.length < 2) return false
    const currentActive = versions.find(v => v.isActive)
    const previousVersion = versions.find(v => !v.isActive && v.version < (currentActive?.version ?? Infinity))
    if (!previousVersion) return false
    return this.activateVersion(agent, previousVersion.version)
  }

  /** Update eval pass rate for a skill version */
  async updateEvalPassRate(agent: string, version: number, passRate: number): Promise<void> {
    const existing = this.versionsByAgent.get(agent)
    const target = existing?.find(v => v.version === version)
    if (target) target.evalPassRate = passRate
  }

  /** Local runtime has no cloud run_feedback DB; returns empty metrics list */
  async getSkillMetrics(): Promise<SkillMetrics[]> {
    return []
  }

  async identifyUnderperformers(threshold = 80): Promise<SkillMetrics[]> {
    const metrics = await this.getSkillMetrics()
    return metrics.filter(m => m.successRate < threshold && m.runs >= 3)
  }
}
