/**
 * 라이브러리 파사드: 폴더 등록, 조회, 메타·태그, 썸네일 URL, 압축 대기열 연결, 중복 후보, 캐시 관리.
 * 파일 이동·삭제·이름 바꾸기·메타데이터 쓰기는 하지 않는다 (원본 비파괴).
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AddResult,
  CacheStats,
  DuplicateGroup,
  IndexingState,
  LibraryItem,
  LibraryQuery,
  LibraryRoot,
  LibraryTreeNode,
  MediaLabel,
} from '../../../shared/types/domain';
import type { LibraryRepository } from '../../repositories/LibraryRepository';
import type { Logger } from '../../platform/logger';
import { AppError } from '../AppError';
import { normalizeForCompare } from '../FileFinalizeService';
import type { JobQueueService } from '../JobQueueService';
import type { LibraryIndexer } from './LibraryIndexer';
import type { MediaTokenRegistry } from './MediaTokenRegistry';
import type { PreviewService } from './PreviewService';
import type { ThumbnailService } from './ThumbnailService';

export interface LibraryDeps {
  repo: LibraryRepository;
  indexer: LibraryIndexer;
  queue: JobQueueService;
  thumbs: ThumbnailService;
  previews: PreviewService;
  tokens: MediaTokenRegistry;
  logger: Logger;
  limitBytes: () => number;
  now?: () => Date;
}

export class LibraryService {
  constructor(private readonly deps: LibraryDeps) {}

  // ----- 루트 -----

  listRoots(): LibraryRoot[] {
    return this.deps.repo.listRoots();
  }

  addRoot(dirPath: string, includeSubfolders: boolean): LibraryRoot {
    let st: fs.Stats;
    try {
      st = fs.statSync(dirPath);
    } catch (err) {
      throw new AppError('LIBRARY_ROOT_INVALID', dirPath, { cause: err });
    }
    if (!st.isDirectory()) throw new AppError('LIBRARY_ROOT_INVALID', '폴더가 아닙니다');
    const key = normalizeForCompare(dirPath);
    for (const r of this.deps.repo.rootPathKeys()) {
      if (r.pathKey === key) throw new AppError('LIBRARY_ROOT_INVALID', '이미 등록된 폴더입니다');
      if (isInside(key, r.pathKey) || isInside(r.pathKey, key)) {
        throw new AppError('LIBRARY_ROOT_INVALID', '이미 등록된 폴더의 상위 또는 하위 폴더입니다');
      }
    }
    const id = randomUUID();
    this.deps.repo.insertRoot({
      id,
      path: path.resolve(dirPath),
      pathKey: key,
      includeSubfolders,
      addedAt: this.now(),
    });
    this.deps.indexer.enqueue(id);
    const root = this.deps.repo.getRoot(id);
    if (!root) throw new AppError('UNKNOWN', '등록 직후 폴더를 찾을 수 없습니다');
    return root;
  }

  removeRoot(id: string): boolean {
    const root = this.deps.repo.getRoot(id);
    if (!root) return false;
    this.deps.repo.deleteItemsOfRoot(id);
    // 항목 ID 별 토큰은 다시 발급되므로 접두사 단위로 모두 무효화한다
    for (const prefix of ['src:item:', 'thumb:', 'scrub:', 'frame:item:', 'full:item:']) {
      this.deps.tokens.revokePrefix(prefix);
    }
    return this.deps.repo.deleteRoot(id);
  }

  reindex(id: string): IndexingState {
    if (!this.deps.repo.getRoot(id)) throw new AppError('MEDIA_NOT_FOUND', `root ${id}`);
    return this.deps.indexer.enqueue(id);
  }

  tree(rootId: string): LibraryTreeNode {
    const root = this.deps.repo.getRoot(rootId);
    if (!root) throw new AppError('MEDIA_NOT_FOUND', `root ${rootId}`);
    return this.deps.repo.tree(rootId, root.path);
  }

  // ----- 항목 -----

  query(q: LibraryQuery): { items: LibraryItem[]; total: number } {
    return this.deps.repo.query({ ...q, dir: q.dir ? normalizeForCompare(q.dir) : null });
  }

  get(id: string): LibraryItem {
    const item = this.deps.repo.getItem(id);
    if (!item) throw new AppError('MEDIA_NOT_FOUND', id);
    return item;
  }

  setMeta(
    id: string,
    patch: { rating?: number; label?: MediaLabel | null; note?: string | null },
  ): LibraryItem {
    const item = this.get(id);
    this.deps.repo.setMeta(normalizeForCompare(item.path), patch);
    return this.get(id);
  }

  listTags(): { name: string; count: number }[] {
    return this.deps.repo.listTags();
  }

  setTags(id: string, tags: string[]): LibraryItem {
    const item = this.get(id);
    const unique = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    this.deps.repo.setTags(normalizeForCompare(item.path), unique);
    return this.get(id);
  }

  // ----- 썸네일 -----

  async thumbUrl(id: string): Promise<string | null> {
    const item = this.get(id);
    if (item.missing || item.kind === 'other') return null;
    try {
      const file = await this.deps.thumbs.thumb(item);
      return this.deps.tokens.issue(`thumb:${id}`, file, 'image/jpeg');
    } catch (err) {
      this.deps.logger.warn('thumbnail failed', { id, err: String(err) });
      return null;
    }
  }

  async scrubUrls(id: string): Promise<{ urls: string[]; timesSec: number[] }> {
    const item = this.get(id);
    if (item.kind !== 'video' || item.missing) return { urls: [], timesSec: [] };
    const { files, times } = await this.deps.thumbs.scrub(item);
    return {
      urls: files.map((f, i) =>
        this.deps.tokens.issue(`scrub:${id}:${String(i)}`, f, 'image/jpeg'),
      ),
      timesSec: times,
    };
  }

  /**
   * 파일이 등록 폴더 안에 있으면 바로 인덱싱하고 항목 ID 를 돌려준다. 밖이면 null.
   * 하위 폴더를 포함하지 않는 등록 폴더는 바로 아래 파일만 해당한다.
   */
  async indexFile(filePath: string): Promise<string | null> {
    const key = normalizeForCompare(filePath);
    const dirKey = normalizeForCompare(path.dirname(filePath));
    for (const r of this.deps.repo.listRoots()) {
      const rootKey = normalizeForCompare(r.path);
      if (!isInside(key, rootKey)) continue;
      if (!r.includeSubfolders && dirKey !== rootKey) continue;
      return this.deps.indexer.indexSingle(r.id, filePath);
    }
    return null;
  }

  // ----- 압축 연결 -----

  enqueue(ids: string[]): AddResult {
    const paths = this.deps.repo
      .getItems(ids)
      .filter((i) => i.kind === 'video' && !i.missing)
      .map((i) => i.path);
    const skippedCount = ids.length - paths.length;
    const result = this.deps.queue.addPaths(paths, false);
    if (skippedCount > 0) {
      result.skipped.push({
        path: '',
        reason: `영상이 아니거나 찾을 수 없는 항목 ${String(skippedCount)}개는 건너뛰었습니다`,
      });
    }
    return result;
  }

  // ----- 중복 -----

  duplicates(): DuplicateGroup[] {
    const groups = this.deps.repo.duplicateCandidates();
    return groups.map((g) => ({
      key: `${String(g.sizeBytes)}:${g.durationSec === null ? '-' : g.durationSec.toFixed(1)}`,
      sizeBytes: g.sizeBytes,
      durationSec: g.durationSec,
      items: this.deps.repo.getItems(g.ids),
      hashes: null,
    }));
  }

  /** 항목의 SHA-256 을 스트리밍으로 계산한다. 큰 파일은 시간이 걸리므로 사용자가 요청할 때만 쓴다. */
  async verifyDuplicates(ids: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const item of this.deps.repo.getItems(ids)) {
      if (item.missing) continue;
      out[item.id] = await sha256File(item.path);
    }
    return out;
  }

  // ----- 캐시 -----

  cacheStats(): CacheStats {
    const t = this.deps.thumbs.stats();
    const p = this.deps.previews.stats();
    return {
      thumbBytes: t.bytes,
      thumbCount: t.count,
      previewBytes: p.bytes,
      previewCount: p.count,
      limitBytes: this.deps.limitBytes(),
    };
  }

  clearCache(): CacheStats {
    this.deps.thumbs.clear();
    this.deps.previews.clear();
    return this.cacheStats();
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}

function isInside(child: string, parent: string): boolean {
  if (!child.startsWith(parent)) return false;
  const rest = child.slice(parent.length);
  return rest.startsWith('/') || rest.startsWith('\\');
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
