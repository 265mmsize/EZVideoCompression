/**
 * 미디어 라이브러리 저장소.
 *
 * - 항목(library_items)은 경로 키로 유일하다. 재인덱싱은 행을 갱신하지 재생성하지 않는다.
 * - 평점·라벨·메모·태그는 경로 키 기준(library_meta, library_item_tags)으로 저장해 항목이 지워졌다 다시 생겨도 유지된다.
 * - 압축 연결은 jobs.input_path_key 와의 조인으로 계산한다 (별도 저장 없음).
 */
import type {
  CompressionLink,
  JobStatus,
  LibraryItem,
  LibraryQuery,
  LibraryRoot,
  LibraryTreeNode,
  MediaKind,
  MediaLabel,
  PreviewAsset,
  JobSettings,
} from '../../shared/types/domain';
import type { Db } from '../database/Database';

interface RootRow {
  id: string;
  path: string;
  path_key: string;
  include_subfolders: number;
  added_at: string;
  last_indexed_at: string | null;
  item_count: number;
}

export interface ItemRow {
  id: string;
  root_id: string;
  path: string;
  path_key: string;
  parent_dir: string;
  parent_dir_key: string;
  file_name: string;
  kind: MediaKind;
  size_bytes: number;
  mtime_ms: number;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  container: string | null;
  probe_json: string | null;
  indexed_at: string | null;
  missing: number;
  error_code: string | null;
  rating: number | null;
  label: string | null;
  note: string | null;
}

export interface ItemUpsert {
  id: string;
  rootId: string;
  path: string;
  pathKey: string;
  parentDir: string;
  parentDirKey: string;
  fileName: string;
  kind: MediaKind;
  sizeBytes: number;
  mtimeMs: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  probeJson: string | null;
  indexedAt: string;
  errorCode: string | null;
}

const ITEM_SELECT = `
  SELECT i.*, m.rating AS rating, m.label AS label, m.note AS note
  FROM library_items i LEFT JOIN library_meta m ON m.path_key = i.path_key`;

export class LibraryRepository {
  constructor(private readonly db: Db) {}

  // ----- 루트 -----

  insertRoot(root: {
    id: string;
    path: string;
    pathKey: string;
    includeSubfolders: boolean;
    addedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO library_roots (id, path, path_key, include_subfolders, added_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(root.id, root.path, root.pathKey, root.includeSubfolders ? 1 : 0, root.addedAt);
  }

  listRoots(): LibraryRoot[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM library_items i WHERE i.root_id = r.id AND i.missing = 0) AS item_count
         FROM library_roots r ORDER BY r.added_at ASC`,
      )
      .all() as unknown as RootRow[];
    return rows.map(toRoot);
  }

  getRoot(id: string): LibraryRoot | null {
    const row = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM library_items i WHERE i.root_id = r.id AND i.missing = 0) AS item_count
         FROM library_roots r WHERE r.id = ?`,
      )
      .get(id) as RootRow | undefined;
    return row ? toRoot(row) : null;
  }

  rootPathKeys(): { id: string; pathKey: string }[] {
    const rows = this.db.prepare('SELECT id, path_key FROM library_roots').all() as {
      id: string;
      path_key: string;
    }[];
    return rows.map((r) => ({ id: r.id, pathKey: r.path_key }));
  }

  deleteRoot(id: string): boolean {
    const r = this.db.prepare('DELETE FROM library_roots WHERE id = ?').run(id);
    return Number(r.changes) > 0;
  }

  setRootIndexed(id: string, at: string): void {
    this.db.prepare('UPDATE library_roots SET last_indexed_at = ? WHERE id = ?').run(at, id);
  }

  // ----- 항목 -----

  /** 루트의 기존 항목 요약 (변경 감지용) */
  itemStatsForRoot(
    rootId: string,
  ): Map<string, { id: string; sizeBytes: number; mtimeMs: number }> {
    const rows = this.db
      .prepare('SELECT id, path_key, size_bytes, mtime_ms FROM library_items WHERE root_id = ?')
      .all(rootId) as { id: string; path_key: string; size_bytes: number; mtime_ms: number }[];
    const map = new Map<string, { id: string; sizeBytes: number; mtimeMs: number }>();
    for (const r of rows)
      map.set(r.path_key, { id: r.id, sizeBytes: r.size_bytes, mtimeMs: r.mtime_ms });
    return map;
  }

  upsertItem(it: ItemUpsert): void {
    this.db
      .prepare(
        `INSERT INTO library_items (id, root_id, path, path_key, parent_dir, parent_dir_key, file_name, kind,
           size_bytes, mtime_ms, width, height, duration_sec, video_codec, audio_codec, container,
           probe_json, indexed_at, missing, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(path_key) DO UPDATE SET
           root_id = excluded.root_id, path = excluded.path, parent_dir = excluded.parent_dir,
           parent_dir_key = excluded.parent_dir_key, file_name = excluded.file_name, kind = excluded.kind,
           size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, width = excluded.width,
           height = excluded.height, duration_sec = excluded.duration_sec, video_codec = excluded.video_codec,
           audio_codec = excluded.audio_codec, container = excluded.container, probe_json = excluded.probe_json,
           indexed_at = excluded.indexed_at, missing = 0, error_code = excluded.error_code`,
      )
      .run(
        it.id,
        it.rootId,
        it.path,
        it.pathKey,
        it.parentDir,
        it.parentDirKey,
        it.fileName,
        it.kind,
        it.sizeBytes,
        it.mtimeMs,
        it.width,
        it.height,
        it.durationSec,
        it.videoCodec,
        it.audioCodec,
        it.container,
        it.probeJson,
        it.indexedAt,
        it.errorCode,
      );
  }

  /** 변경 없는 항목: 존재 확인만 갱신한다 */
  touchItems(ids: readonly string[], at: string): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`UPDATE library_items SET missing = 0, indexed_at = ? WHERE id IN (${placeholders})`)
      .run(at, ...ids);
  }

  /** 이번 인덱싱에서 보지 못한 항목을 "없음"으로 표시한다 */
  markMissingExcept(rootId: string, seenIds: ReadonlySet<string>): number {
    const rows = this.db
      .prepare('SELECT id FROM library_items WHERE root_id = ? AND missing = 0')
      .all(rootId) as { id: string }[];
    const gone = rows.map((r) => r.id).filter((id) => !seenIds.has(id));
    for (let i = 0; i < gone.length; i += 500) {
      const chunk = gone.slice(i, i + 500);
      this.db
        .prepare(
          `UPDATE library_items SET missing = 1 WHERE id IN (${chunk.map(() => '?').join(',')})`,
        )
        .run(...chunk);
    }
    return gone.length;
  }

  getItem(id: string): LibraryItem | null {
    const row = this.db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as ItemRow | undefined;
    if (!row) return null;
    return this.assemble([row])[0] ?? null;
  }

  getItemRow(id: string): ItemRow | null {
    return (
      (this.db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as ItemRow | undefined) ?? null
    );
  }

  getItemByPathKey(pathKey: string): LibraryItem | null {
    const row = this.db.prepare(`${ITEM_SELECT} WHERE i.path_key = ?`).get(pathKey) as
      ItemRow | undefined;
    if (!row) return null;
    return this.assemble([row])[0] ?? null;
  }

  getItems(ids: readonly string[]): LibraryItem[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`${ITEM_SELECT} WHERE i.id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as unknown as ItemRow[];
    return this.assemble(rows);
  }

  query(q: LibraryQuery): { items: LibraryItem[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.rootId) {
      where.push('i.root_id = ?');
      params.push(q.rootId);
    }
    if (q.dir) {
      // 폴더 자신과 하위 폴더. 경로 키는 정규화된 절대 경로이므로 접두사 비교가 안전하다 (구분자 포함).
      const key = q.dir;
      where.push("(i.parent_dir_key = ? OR i.parent_dir_key LIKE ? ESCAPE '!')");
      params.push(key, `${escapeLike(key)}%`);
    }
    if (q.kinds.length > 0 && q.kinds.length < 3) {
      where.push(`i.kind IN (${q.kinds.map(() => '?').join(',')})`);
      params.push(...q.kinds);
    }
    if (q.search.trim()) {
      where.push("i.file_name LIKE ? ESCAPE '!'");
      params.push(`%${escapeLike(q.search.trim())}%`);
    }
    if (q.minRating > 0) {
      where.push('COALESCE(m.rating, 0) >= ?');
      params.push(q.minRating);
    }
    if (q.label) {
      where.push('m.label = ?');
      params.push(q.label);
    }
    for (const tag of q.tags) {
      where.push(
        'EXISTS (SELECT 1 FROM library_item_tags it JOIN library_tags t ON t.id = it.tag_id WHERE it.path_key = i.path_key AND t.name = ?)',
      );
      params.push(tag);
    }
    if (q.compressed !== 'any') {
      const exists = 'EXISTS (SELECT 1 FROM jobs j WHERE j.input_path_key = i.path_key)';
      where.push(q.compressed === 'yes' ? exists : `NOT ${exists}`);
    }
    if (!q.includeMissing) where.push('i.missing = 0');

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderCol: Record<LibraryQuery['sort'], string> = {
      name: 'i.file_name COLLATE NOCASE',
      date: 'i.mtime_ms',
      size: 'i.size_bytes',
      duration: 'COALESCE(i.duration_sec, -1)',
      rating: 'COALESCE(m.rating, 0)',
    };
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM library_items i LEFT JOIN library_meta m ON m.path_key = i.path_key ${whereSql}`,
        )
        .get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `${ITEM_SELECT} ${whereSql} ORDER BY ${orderCol[q.sort]} ${dir}, i.file_name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit, q.offset) as unknown as ItemRow[];
    return { items: this.assemble(rows), total };
  }

  /** 폴더 트리: 루트 아래 폴더별 항목 수 */
  tree(rootId: string, rootPath: string): LibraryTreeNode {
    const rows = this.db
      .prepare(
        'SELECT parent_dir, COUNT(*) AS n FROM library_items WHERE root_id = ? AND missing = 0 GROUP BY parent_dir',
      )
      .all(rootId) as { parent_dir: string; n: number }[];
    return buildTree(rootPath, rows);
  }

  /** 크기·길이가 같은 항목 묶음 (중복 후보) */
  duplicateCandidates(): { sizeBytes: number; durationSec: number | null; ids: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT size_bytes, ROUND(COALESCE(duration_sec, -1), 1) AS d, GROUP_CONCAT(id) AS ids
         FROM library_items WHERE missing = 0 AND kind != 'other'
         GROUP BY size_bytes, d HAVING COUNT(*) > 1
         ORDER BY size_bytes DESC LIMIT 500`,
      )
      .all() as { size_bytes: number; d: number; ids: string }[];
    return rows.map((r) => ({
      sizeBytes: r.size_bytes,
      durationSec: r.d < 0 ? null : r.d,
      ids: r.ids.split(','),
    }));
  }

  deleteItemsOfRoot(rootId: string): string[] {
    const keys = (
      this.db.prepare('SELECT path_key FROM library_items WHERE root_id = ?').all(rootId) as {
        path_key: string;
      }[]
    ).map((r) => r.path_key);
    this.db.prepare('DELETE FROM library_items WHERE root_id = ?').run(rootId);
    return keys;
  }

  // ----- 메타·태그 -----

  setMeta(
    pathKey: string,
    patch: { rating?: number; label?: MediaLabel | null; note?: string | null },
  ): void {
    const cur = this.db
      .prepare('SELECT rating, label, note FROM library_meta WHERE path_key = ?')
      .get(pathKey) as { rating: number; label: string | null; note: string | null } | undefined;
    const rating = patch.rating ?? cur?.rating ?? 0;
    const label = patch.label !== undefined ? patch.label : (cur?.label ?? null);
    const note = patch.note !== undefined ? patch.note : (cur?.note ?? null);
    this.db
      .prepare(
        `INSERT INTO library_meta (path_key, rating, label, note) VALUES (?, ?, ?, ?)
         ON CONFLICT(path_key) DO UPDATE SET rating = excluded.rating, label = excluded.label, note = excluded.note`,
      )
      .run(pathKey, rating, label, note);
  }

  listTags(): { name: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT t.name AS name, COUNT(it.path_key) AS count FROM library_tags t
         LEFT JOIN library_item_tags it ON it.tag_id = t.id GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
      )
      .all() as { name: string; count: number }[];
  }

  setTags(pathKey: string, tags: readonly string[]): void {
    this.db.prepare('DELETE FROM library_item_tags WHERE path_key = ?').run(pathKey);
    for (const raw of tags) {
      const name = raw.trim();
      if (!name) continue;
      this.db.prepare('INSERT OR IGNORE INTO library_tags (name) VALUES (?)').run(name);
      const t = this.db.prepare('SELECT id FROM library_tags WHERE name = ?').get(name) as {
        id: number;
      };
      this.db
        .prepare('INSERT OR IGNORE INTO library_item_tags (path_key, tag_id) VALUES (?, ?)')
        .run(pathKey, t.id);
    }
    // 어떤 항목에도 쓰이지 않는 태그는 정리한다
    this.db.exec(
      'DELETE FROM library_tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM library_item_tags)',
    );
  }

  // ----- 썸네일 캐시 -----

  getThumb(cacheKey: string): { file: string; bytes: number } | null {
    const row = this.db
      .prepare('SELECT file, bytes FROM thumbnails WHERE cache_key = ?')
      .get(cacheKey) as { file: string; bytes: number } | undefined;
    return row ?? null;
  }

  putThumb(cacheKey: string, file: string, bytes: number, at: string): void {
    this.db
      .prepare(
        `INSERT INTO thumbnails (cache_key, file, bytes, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET file = excluded.file, bytes = excluded.bytes, last_used_at = excluded.last_used_at`,
      )
      .run(cacheKey, file, bytes, at, at);
  }

  touchThumb(cacheKey: string, at: string): void {
    this.db.prepare('UPDATE thumbnails SET last_used_at = ? WHERE cache_key = ?').run(at, cacheKey);
  }

  thumbStats(): { bytes: number; count: number } {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM thumbnails')
      .get() as {
      bytes: number;
      count: number;
    };
    return r;
  }

  oldestThumbs(limit: number): { cacheKey: string; file: string; bytes: number }[] {
    const rows = this.db
      .prepare('SELECT cache_key, file, bytes FROM thumbnails ORDER BY last_used_at ASC LIMIT ?')
      .all(limit) as { cache_key: string; file: string; bytes: number }[];
    return rows.map((r) => ({ cacheKey: r.cache_key, file: r.file, bytes: r.bytes }));
  }

  deleteThumb(cacheKey: string): void {
    this.db.prepare('DELETE FROM thumbnails WHERE cache_key = ?').run(cacheKey);
  }

  allThumbs(): { cacheKey: string; file: string }[] {
    const rows = this.db.prepare('SELECT cache_key, file FROM thumbnails').all() as {
      cache_key: string;
      file: string;
    }[];
    return rows.map((r) => ({ cacheKey: r.cache_key, file: r.file }));
  }

  // ----- 미리보기 -----

  insertPreview(p: {
    id: string;
    kind: 'proxy' | 'settings';
    sourceKey: string;
    file: string;
    bytes: number;
    durationSec: number | null;
    settings: JobSettings | null;
    startSec: number | null;
    note: string;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO previews (id, kind, source_key, file, bytes, duration_sec, settings_json, start_sec, note, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.kind,
        p.sourceKey,
        p.file,
        p.bytes,
        p.durationSec,
        p.settings ? JSON.stringify(p.settings) : null,
        p.startSec,
        p.note,
        p.at,
        p.at,
      );
  }

  getPreview(id: string): PreviewRow | null {
    return (
      (this.db.prepare('SELECT * FROM previews WHERE id = ?').get(id) as PreviewRow | undefined) ??
      null
    );
  }

  listPreviews(sourceKey: string): PreviewRow[] {
    return this.db
      .prepare('SELECT * FROM previews WHERE source_key = ? ORDER BY created_at DESC')
      .all(sourceKey) as unknown as PreviewRow[];
  }

  allPreviews(): PreviewRow[] {
    return this.db.prepare('SELECT * FROM previews').all() as unknown as PreviewRow[];
  }

  deletePreview(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM previews WHERE id = ?').run(id).changes) > 0;
  }

  previewStats(): { bytes: number; count: number } {
    return this.db
      .prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM previews')
      .get() as {
      bytes: number;
      count: number;
    };
  }

  // ----- 조립 -----

  private assemble(rows: ItemRow[]): LibraryItem[] {
    if (rows.length === 0) return [];
    const keys = rows.map((r) => r.path_key);
    const placeholders = keys.map(() => '?').join(',');
    const tagRows = this.db
      .prepare(
        `SELECT it.path_key AS path_key, t.name AS name FROM library_item_tags it JOIN library_tags t ON t.id = it.tag_id
         WHERE it.path_key IN (${placeholders}) ORDER BY t.name COLLATE NOCASE`,
      )
      .all(...keys) as { path_key: string; name: string }[];
    const tagsByKey = new Map<string, string[]>();
    for (const t of tagRows) {
      const list = tagsByKey.get(t.path_key) ?? [];
      list.push(t.name);
      tagsByKey.set(t.path_key, list);
    }
    // 같은 입력 경로의 가장 최근 작업 하나
    const jobRows = this.db
      .prepare(
        `SELECT id, input_path_key, status, output_path, output_size_bytes, savings_ratio FROM jobs
         WHERE input_path_key IN (${placeholders}) ORDER BY created_at ASC`,
      )
      .all(...keys) as {
      id: string;
      input_path_key: string;
      status: JobStatus;
      output_path: string | null;
      output_size_bytes: number | null;
      savings_ratio: number | null;
    }[];
    const jobByKey = new Map<string, CompressionLink>();
    for (const j of jobRows) {
      jobByKey.set(j.input_path_key, {
        jobId: j.id,
        status: j.status,
        outputPath: j.output_path,
        outputSizeBytes: j.output_size_bytes,
        savingsRatio: j.savings_ratio,
      });
    }
    return rows.map((r) => ({
      id: r.id,
      rootId: r.root_id,
      path: r.path,
      fileName: r.file_name,
      parentDir: r.parent_dir,
      kind: r.kind,
      sizeBytes: r.size_bytes,
      mtimeMs: r.mtime_ms,
      width: r.width,
      height: r.height,
      durationSec: r.duration_sec,
      videoCodec: r.video_codec,
      audioCodec: r.audio_codec,
      container: r.container,
      indexedAt: r.indexed_at,
      missing: r.missing === 1,
      errorCode: r.error_code,
      rating: r.rating ?? 0,
      label: (r.label as MediaLabel | null) ?? null,
      note: r.note,
      tags: tagsByKey.get(r.path_key) ?? [],
      compression: jobByKey.get(r.path_key) ?? null,
    }));
  }
}

export interface PreviewRow {
  id: string;
  kind: 'proxy' | 'settings';
  source_key: string;
  file: string;
  bytes: number;
  duration_sec: number | null;
  settings_json: string | null;
  start_sec: number | null;
  note: string;
  created_at: string;
  last_used_at: string;
}

export function toPreviewAsset(row: PreviewRow, url: string): PreviewAsset {
  return {
    id: row.id,
    kind: row.kind,
    sourceKey: row.source_key,
    url,
    sizeBytes: row.bytes,
    durationSec: row.duration_sec,
    createdAt: row.created_at,
    note: row.note,
    settings: row.settings_json ? (JSON.parse(row.settings_json) as JobSettings) : null,
    startSec: row.start_sec,
  };
}

function toRoot(r: RootRow): LibraryRoot {
  return {
    id: r.id,
    path: r.path,
    includeSubfolders: r.include_subfolders === 1,
    addedAt: r.added_at,
    lastIndexedAt: r.last_indexed_at,
    itemCount: r.item_count,
  };
}

function escapeLike(s: string): string {
  return s.replace(/[!%_]/g, (c) => `!${c}`);
}

/** 폴더별 집계를 트리로 만든다. 루트 아래의 중간 폴더(항목이 없는 폴더)도 노드로 만든다. */
export function buildTree(
  rootPath: string,
  rows: { parent_dir: string; n: number }[],
): LibraryTreeNode {
  const sep = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/';
  const root: LibraryTreeNode = {
    path: rootPath,
    name: baseName(rootPath, sep),
    itemCount: 0,
    children: [],
  };
  const nodes = new Map<string, LibraryTreeNode>([[rootPath, root]]);
  const ensure = (dir: string): LibraryTreeNode => {
    const hit = nodes.get(dir);
    if (hit) return hit;
    const parent = dir.slice(0, dir.lastIndexOf(sep));
    const parentNode = parent.length >= rootPath.length ? ensure(parent) : root;
    const node: LibraryTreeNode = {
      path: dir,
      name: baseName(dir, sep),
      itemCount: 0,
      children: [],
    };
    parentNode.children.push(node);
    nodes.set(dir, node);
    return node;
  };
  for (const r of rows) {
    if (r.parent_dir === rootPath) root.itemCount = r.n;
    else if (r.parent_dir.startsWith(rootPath)) ensure(r.parent_dir).itemCount = r.n;
  }
  const sortRec = (n: LibraryTreeNode): void => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function baseName(p: string, sep: string): string {
  const parts = p.split(sep).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
