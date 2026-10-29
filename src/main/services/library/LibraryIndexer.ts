/**
 * 라이브러리 인덱서.
 *
 * - 등록 폴더를 훑어 영상·이미지 후보를 찾고 ffprobe 로 해상도·길이·코덱을 읽어 DB 에 저장한다.
 * - 크기·수정 시간이 같은 항목은 다시 분석하지 않는다 (존재 확인만 갱신).
 * - 이번 실행에서 보지 못한 항목은 "없음"으로 표시한다. 메타(평점·태그)는 경로 키 기준이라 유지된다.
 * - 한 번에 하나의 루트만 처리하는 직렬 큐. 취소할 수 있고, 진행 상태를 이벤트로 알린다.
 * - 원본 파일에는 어떤 쓰기도 하지 않는다.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IndexingState, MediaKind, ProbeResult } from '../../../shared/types/domain';
import type { LibraryRepository } from '../../repositories/LibraryRepository';
import type { Logger } from '../../platform/logger';
import { AppError } from '../AppError';
import { normalizeForCompare } from '../FileFinalizeService';
import { VIDEO_EXTENSIONS } from '../JobQueueService';
import type { MediaProbeService } from '../MediaProbeService';

/** 이미지 후보 확장자. HEIC/RAW 는 번들 FFmpeg 와 Chromium 모두 디코딩하지 못하므로 제외한다. */
export const IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.avif',
];

export const MAX_ITEMS_PER_ROOT = 50_000;
const PROGRESS_INTERVAL_MS = 250;

export interface IndexerDeps {
  repo: LibraryRepository;
  probe: MediaProbeService;
  logger: Logger;
  emit: (state: IndexingState) => void;
  toolsReady: () => Promise<void>;
  /** 테스트용 시계 */
  now?: () => Date;
}

export interface ScannedFile {
  path: string;
  kind: MediaKind;
  sizeBytes: number;
  mtimeMs: number;
}

export function kindOfExtension(ext: string): MediaKind {
  const e = ext.toLowerCase();
  if (VIDEO_EXTENSIONS.includes(e)) return 'video';
  if (IMAGE_EXTENSIONS.includes(e)) return 'image';
  return 'other';
}

/** 폴더를 훑는다. 심볼릭 링크·숨김 파일·앱 임시 파일은 건너뛴다. 상한을 넘으면 멈춘다. */
export function scanRoot(
  root: string,
  recursive: boolean,
  shouldStop: () => boolean = () => false,
): { files: ScannedFile[]; truncated: boolean; unreadableDirs: string[] } {
  const files: ScannedFile[] = [];
  const unreadableDirs: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    if (shouldStop()) break;
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadableDirs.push(dir);
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.includes('.vslim-tmp-')) continue;
      const kind = kindOfExtension(path.extname(e.name));
      if (kind === 'other') continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      files.push({ path: full, kind, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      if (files.length >= MAX_ITEMS_PER_ROOT) return { files, truncated: true, unreadableDirs };
    }
  }
  return { files, truncated: false, unreadableDirs };
}

export class LibraryIndexer {
  private queue: string[] = [];
  private running = false;
  private abort: AbortController | null = null;
  private state: IndexingState = {
    running: false,
    rootId: null,
    processed: 0,
    total: 0,
    currentFile: null,
    lastError: null,
  };
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: IndexerDeps) {}

  getState(): IndexingState {
    return { ...this.state };
  }

  /** 루트를 인덱싱 큐에 넣는다. 이미 큐에 있으면 무시한다. */
  enqueue(rootId: string): IndexingState {
    if (!this.queue.includes(rootId) && this.state.rootId !== rootId) this.queue.push(rootId);
    this.pump();
    return this.getState();
  }

  /** 현재 작업과 대기 중인 작업을 모두 취소한다 */
  cancel(): IndexingState {
    this.queue = [];
    this.abort?.abort();
    return this.getState();
  }

  /** 모든 큐가 끝날 때까지 기다린다 (테스트·종료용) */
  async idle(): Promise<void> {
    await this.chain;
  }

  private pump(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    this.chain = this.runRoot(next)
      .catch((err: unknown) => {
        this.deps.logger.error('indexer error', { rootId: next, err: String(err) });
        this.patch({ lastError: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        this.running = false;
        this.patch({ running: false, rootId: null, currentFile: null });
        this.pump();
      });
  }

  private patch(p: Partial<IndexingState>): void {
    this.state = { ...this.state, ...p };
    this.deps.emit(this.getState());
  }

  private async runRoot(rootId: string): Promise<void> {
    const root = this.deps.repo.getRoot(rootId);
    if (!root) return;
    const controller = new AbortController();
    this.abort = controller;
    this.patch({
      running: true,
      rootId,
      processed: 0,
      total: 0,
      currentFile: null,
      lastError: null,
    });
    await this.deps.toolsReady();

    const scan = scanRoot(root.path, root.includeSubfolders, () => controller.signal.aborted);
    if (scan.truncated) {
      this.deps.logger.warn('index truncated', { rootId, max: MAX_ITEMS_PER_ROOT });
    }
    this.patch({ total: scan.files.length });

    const known = this.deps.repo.itemStatsForRoot(rootId);
    const seen = new Set<string>();
    const unchanged: string[] = [];
    let lastEmit = 0;
    let processed = 0;
    let errors = 0;

    for (const f of scan.files) {
      if (controller.signal.aborted) break;
      const key = normalizeForCompare(f.path);
      const prev = known.get(key);
      if (
        prev &&
        prev.sizeBytes === f.sizeBytes &&
        Math.floor(prev.mtimeMs) === Math.floor(f.mtimeMs)
      ) {
        unchanged.push(prev.id);
        seen.add(prev.id);
      } else {
        const id = prev?.id ?? randomUUID();
        seen.add(id);
        try {
          await this.indexOne(id, rootId, f, key);
        } catch (err) {
          errors += 1;
          const app = AppError.from(err);
          this.deps.repo.upsertItem({
            ...baseUpsert(id, rootId, f, key, this.now()),
            errorCode: app.code,
          });
        }
      }
      processed += 1;
      const t = Date.now();
      if (t - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = t;
        this.patch({ processed, currentFile: f.path });
      }
    }

    if (!controller.signal.aborted) {
      this.deps.repo.touchItems(unchanged, this.now());
      const gone = this.deps.repo.markMissingExcept(rootId, seen);
      this.deps.repo.setRootIndexed(rootId, this.now());
      this.deps.logger.info('index done', {
        rootId,
        files: scan.files.length,
        reprobed: processed - unchanged.length,
        missing: gone,
        errors,
        unreadableDirs: scan.unreadableDirs.length,
      });
    } else {
      // 취소: 이미 처리한 항목은 그대로 두고, 없음 표시는 하지 않는다 (불완전한 정보로 판단하지 않기 위해)
      this.deps.repo.touchItems(unchanged, this.now());
      this.deps.logger.info('index cancelled', { rootId, processed });
    }
    this.patch({ processed, currentFile: null });
  }

  /**
   * 파일 하나를 바로 인덱싱한다 (편집 결과 저장 직후 등). 폴더 전체 스캔은 하지 않는다.
   * 기존 항목이 있으면 갱신한다. 반환값은 항목 ID.
   */
  async indexSingle(rootId: string, filePath: string): Promise<string> {
    await this.deps.toolsReady();
    const st = fs.statSync(filePath);
    const f: ScannedFile = {
      path: filePath,
      kind: kindOfExtension(path.extname(filePath)),
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    };
    const key = normalizeForCompare(filePath);
    const id = this.deps.repo.getItemByPathKey(key)?.id ?? randomUUID();
    try {
      await this.indexOne(id, rootId, f, key);
    } catch (err) {
      const app = AppError.from(err);
      this.deps.repo.upsertItem({
        ...baseUpsert(id, rootId, f, key, this.now()),
        errorCode: app.code,
      });
    }
    return id;
  }

  private async indexOne(id: string, rootId: string, f: ScannedFile, key: string): Promise<void> {
    const probe = await this.deps.probe.probe(f.path);
    const video = probe.streams.find((s) => s.kind === 'video' && !s.isAttachedPic) ?? null;
    const audio = probe.streams.find((s) => s.kind === 'audio') ?? null;
    this.deps.repo.upsertItem({
      ...baseUpsert(id, rootId, f, key, this.now()),
      width: video?.width ?? null,
      height: video?.height ?? null,
      // 이미지는 길이가 없다. 영상은 컨테이너 길이를 쓴다.
      durationSec: f.kind === 'video' ? probe.durationSec.value : null,
      videoCodec: video?.codecName ?? null,
      audioCodec: audio?.codecName ?? null,
      container: probe.formatName,
      probeJson: JSON.stringify(slimProbe(probe)),
    });
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}

function baseUpsert(id: string, rootId: string, f: ScannedFile, key: string, at: string) {
  const parentDir = path.dirname(f.path);
  return {
    id,
    rootId,
    path: f.path,
    pathKey: key,
    parentDir,
    parentDirKey: normalizeForCompare(parentDir),
    fileName: path.basename(f.path),
    kind: f.kind,
    sizeBytes: f.sizeBytes,
    mtimeMs: f.mtimeMs,
    width: null,
    height: null,
    durationSec: null,
    videoCodec: null,
    audioCodec: null,
    container: null,
    probeJson: null,
    indexedAt: at,
    errorCode: null,
  };
}

/** 저장 용량을 줄이기 위해 재생 판정에 필요한 필드만 남긴다 */
function slimProbe(p: ProbeResult): Pick<ProbeResult, 'formatName' | 'durationSec' | 'streams'> {
  return {
    formatName: p.formatName,
    durationSec: p.durationSec,
    streams: p.streams.map((s) => ({
      ...s,
      disposition: {},
    })),
  };
}
