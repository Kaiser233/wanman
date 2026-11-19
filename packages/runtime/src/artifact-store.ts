/**
 * Local SQLite-backed structured artifact store.
 *
 * Replaces cloud db9 artifact storage so `wanman artifact put|list|get`
 * works completely offline and locally.
 */

import type Database from 'better-sqlite3';

export interface ArtifactRow {
  id: number;
  agent: string;
  kind: string;
  path: string | null;
  content: string | null;
  content_length: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PutArtifactInput {
  agent: string;
  kind: string;
  path?: string;
  content?: string;
  metadata: Record<string, unknown>;
}

export interface ListArtifactsFilter {
  agent?: string;
  kind?: string;
  verified?: boolean;
}

export class ArtifactStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        content TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_agent ON artifacts (agent);
      CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts (kind);
    `);
  }

  put(input: PutArtifactInput): { id: number; agent: string; kind: string; created_at: string } {
    const createdAt = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO artifacts (agent, kind, path, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      input.agent,
      input.kind,
      input.path ?? null,
      input.content ?? null,
      JSON.stringify(input.metadata),
      createdAt,
    );
    return {
      id: Number(info.lastInsertRowid),
      agent: input.agent,
      kind: input.kind,
      created_at: createdAt,
    };
  }

  list(filter: ListArtifactsFilter = {}): Array<Omit<ArtifactRow, 'content'>> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.agent) {
      conditions.push('agent = ?');
      params.push(filter.agent);
    }
    if (filter.kind) {
      conditions.push('kind = ?');
      params.push(filter.kind);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT id, agent, kind, path, length(content) as content_length, metadata, created_at
      FROM artifacts
      ${where}
      ORDER BY id DESC
      LIMIT 100
    `).all(...params) as Array<{
      id: number;
      agent: string;
      kind: string;
      path: string | null;
      content_length: number | null;
      metadata: string;
      created_at: string;
    }>;

    const parsed = rows.map(row => ({
      id: row.id,
      agent: row.agent,
      kind: row.kind,
      path: row.path,
      content_length: row.content_length,
      metadata: parseMetadata(row.metadata),
      created_at: row.created_at,
    }));

    if (filter.verified !== undefined) {
      return parsed.filter(row => Boolean(row.metadata['verified']) === filter.verified);
    }

    return parsed;
  }

  get(id: number): ArtifactRow[] {
    const row = this.db.prepare(`
      SELECT id, agent, kind, path, content, length(content) as content_length, metadata, created_at
      FROM artifacts
      WHERE id = ?
    `).get(id) as {
      id: number;
      agent: string;
      kind: string;
      path: string | null;
      content: string | null;
      content_length: number | null;
      metadata: string;
      created_at: string;
    } | undefined;

    if (!row) return [];
    return [{
      id: row.id,
      agent: row.agent,
      kind: row.kind,
      path: row.path,
      content: row.content,
      content_length: row.content_length,
      metadata: parseMetadata(row.metadata),
      created_at: row.created_at,
    }];
  }
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
