/**
 * 영상 편집 프로젝트 저장소. 프로젝트 전체를 JSON 으로 보관한다 (마이그레이션 4).
 */
import type { Db } from '../database/Database';
import type { EditProject, EditProjectSummary } from '../../shared/types/domain';

interface Row {
  id: string;
  name: string;
  json: string;
  created_at: string;
  updated_at: string;
}

export class EditProjectRepository {
  constructor(private readonly db: Db) {}

  list(
    summarize: (p: EditProject) => { clipCount: number; durationSec: number },
  ): EditProjectSummary[] {
    const rows = this.db
      .prepare(
        'SELECT id, name, json, created_at, updated_at FROM edit_projects ORDER BY updated_at DESC',
      )
      .all() as unknown as Row[];
    return rows.map((r) => {
      const p = JSON.parse(r.json) as EditProject;
      const s = summarize(p);
      return {
        id: r.id,
        name: r.name,
        clipCount: s.clipCount,
        durationSec: s.durationSec,
        updatedAt: r.updated_at,
      };
    });
  }

  get(id: string): EditProject | null {
    const row = this.db.prepare('SELECT json FROM edit_projects WHERE id = ?').get(id) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as EditProject) : null;
  }

  insert(p: EditProject): void {
    this.db
      .prepare(
        'INSERT INTO edit_projects (id, name, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(p.id, p.name, JSON.stringify(p), p.createdAt, p.updatedAt);
  }

  update(p: EditProject): boolean {
    const r = this.db
      .prepare('UPDATE edit_projects SET name = ?, json = ?, updated_at = ? WHERE id = ?')
      .run(p.name, JSON.stringify(p), p.updatedAt, p.id);
    return Number(r.changes) > 0;
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM edit_projects WHERE id = ?').run(id).changes) > 0;
  }
}
