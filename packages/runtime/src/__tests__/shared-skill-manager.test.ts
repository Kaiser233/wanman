import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SharedSkillManager } from '../shared-skill-manager.js'

describe('SharedSkillManager', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists filesystem skills sorted by name', () => {
    const { manager } = createManagerWithSkill('playbook', '# Playbook', tempRoots)
    const skills = manager.listFilesystemSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe('playbook')
    expect(skills[0]?.content).toBe('# Playbook')
  })

  it('verifies snapshot storage can materialize a probe copy', () => {
    const { manager, root } = createManagerWithSkill('playbook', '# Playbook', tempRoots)

    manager.verifyActivationInfrastructure()

    const snapshotRoot = path.join(root, 'skill-snapshots')
    expect(fs.existsSync(snapshotRoot)).toBe(true)
    expect(fs.readdirSync(snapshotRoot).filter(name => name.startsWith('.probe-'))).toHaveLength(0)
  })

  it('materializes activation snapshots with copied skill files', async () => {
    const { manager, root } = createManagerWithSkill('research', '# Research', tempRoots)

    const snapshot = await manager.createActivationSnapshot({
      runId: 'run-123',
      loopNumber: 2,
      taskId: 'task-456',
      agent: 'ceo',
      executionProfile: 'research.deep_dive',
      activationScope: 'task',
      activatedBy: 'system',
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot?.resolvedSkills).toHaveLength(1)
    expect(snapshot?.resolvedSkills[0]?.skillName).toBe('research')
    expect(snapshot?.taskId).toBe('task-456')
    expect(snapshot?.executionProfile).toBe('research.deep_dive')

    const copiedSkillPath = path.join(snapshot!.materializedPath, 'research', 'SKILL.md')
    expect(fs.existsSync(copiedSkillPath)).toBe(true)
    expect(fs.readFileSync(copiedSkillPath, 'utf-8')).toBe('# Research')
    expect(snapshot?.materializedPath.startsWith(path.join(root, 'skill-snapshots'))).toBe(true)
  })

  it('cleans up materialized snapshots', async () => {
    const { manager } = createManagerWithSkill('research', '# Research', tempRoots)

    const snapshot = await manager.createActivationSnapshot({
      runId: 'run-123',
      agent: 'ceo',
      activationScope: 'run',
    })

    expect(snapshot).not.toBeNull()
    expect(fs.existsSync(snapshot!.materializedPath)).toBe(true)

    manager.cleanupSnapshots([snapshot!])
    expect(fs.existsSync(snapshot!.materializedPath)).toBe(false)
  })
})

function createManagerWithSkill(skillName: string, content: string, tempRoots: string[]): {
  manager: SharedSkillManager
  root: string
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanman-shared-skills-'))
  tempRoots.push(root)
  const sharedSkillsDir = path.join(root, 'shared-skills')
  const skillDir = path.join(sharedSkillsDir, skillName)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content)

  return {
    manager: new SharedSkillManager(sharedSkillsDir),
    root,
  }
}
