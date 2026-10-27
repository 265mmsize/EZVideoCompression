/**
 * 썸네일·프레임 캐시.
 *
 * - 모든 생성물은 JPEG 이며 userData/thumbs/<2자리>/<키>.jpg 에 둔다. DB(thumbnails)가 목록과 최근 사용 시각을 관리한다.
 * - 캐시 키는 경로 키 + 크기 + 수정 시간 + 변형(종류, 시점)이다. 원본이 바뀌면 자연히 새 키가 된다.
 * - 동시 생성 수는 호출자가 정한다 (인코딩 중에는 1개). 같은 키의 요청은 하나로 합친다.
 * - 상한을 넘으면 오래 쓰지 않은 것부터 지운다 (LRU).
 * - 원본 파일에는 쓰지 않는다.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaKind } from '../../../shared/types/domain';
import type { LibraryRepository } from '../../repositories/LibraryRepository';
import type { Logger } from '../../platform/logger';
import { AppError } from '../AppError';
import type { FFmpegProcessService } from '../FFmpegProcessService';
import { normalizeForCompare } from '../FileFinalizeService';
import type { ToolPaths } from '../JobRunner';

export const THUMB_WIDTH = 320;
export const SCRUB_WIDTH = 240;
export const SCRUB_COUNT = 10;
export const FRAME_MAX_WIDTH = 1280;
export const FULL_IMAGE_MAX_WIDTH = 2048;
const CALL_TIMEOUT_MS = 60_000;

export interface MediaFileInfo {
  path: string;
  kind: MediaKind;
  sizeBytes: number;
  mtimeMs: number;
  durationSec: number | null;
}

export interface ThumbnailDeps {
  repo: LibraryRepository;
  proc: FFmpegProcessService;
  tools: () => ToolPaths;
  dir: string;
  logger: Logger;
  limitBytes: () => number;
  /** 동시에 실행할 ffmpeg 수 (인코딩 중 1, 유휴 2) */
  concurrency: () => number;
  now?: () => Date;
}

export function cacheKeyFor(
  info: { path: string; sizeBytes: number; mtimeMs: number },
  variant: string,
): string {
  const raw = `${normalizeForCompare(info.path)}|${String(info.sizeBytes)}|${String(Math.floor(info.mtimeMs))}|${variant}`;
  return createHash('sha1').update(raw).digest('hex');
}

/** 스크럽 시점: 구간 가운데 값들. 길이가 없으면 빈 배열. */
export function scrubTimes(durationSec: number | null, count = SCRUB_COUNT): number[] {
  if (durationSec === null || durationSec <= 0) return [];
  const n = Math.max(1, Math.min(count, Math.floor(durationSec)));
  return Array.from({ length: n }, (_, i) => round2(((i + 0.5) * durationSec) / n));
}

/** 대표 썸네일 시점: 10% 지점 (너무 짧으면 0) */
export function thumbTime(durationSec: number | null): number {
  if (durationSec === null || durationSec < 2) return 0;
  return round2(Math.min(durationSec * 0.1, 30));
}

export class ThumbnailService {
  private readonly inflight = new Map<string, Promise<string>>();
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly deps: ThumbnailDeps) {
    fs.mkdirSync(deps.dir, { recursive: true });
  }

  /** 대표 썸네일 (영상: 10% 지점 프레임, 이미지: 축소본) */
  thumb(info: MediaFileInfo): Promise<string> {
    const key = cacheKeyFor(info, 'thumb');
    return this.cached(key, async (out) => {
      if (info.kind === 'video') {
        await this.extract(info.path, thumbTime(info.durationSec), THUMB_WIDTH, 5, out, true);
      } else {
        await this.extract(info.path, null, THUMB_WIDTH, 5, out, false);
      }
    });
  }

  /** 영상 스크럽용 시점별 썸네일 */
  async scrub(info: MediaFileInfo): Promise<{ files: string[]; times: number[] }> {
    const times = scrubTimes(info.durationSec);
    const files: string[] = [];
    for (const [i, t] of times.entries()) {
      const key = cacheKeyFor(info, `scrub${String(SCRUB_COUNT)}-${String(i)}`);
      files.push(
        await this.cached(key, (out) => this.extract(info.path, t, SCRUB_WIDTH, 6, out, true)),
      );
    }
    return { files, times };
  }

  /** 정확한 시점의 프레임 (최대 1280px). 0.1초 단위로 캐시한다. */
  frame(info: MediaFileInfo, timeSec: number): Promise<string> {
    const t = Math.max(0, Math.round(timeSec * 10) / 10);
    const key = cacheKeyFor(info, `frame-${t.toFixed(1)}`);
    return this.cached(key, (out) => this.extract(info.path, t, FRAME_MAX_WIDTH, 3, out, true));
  }

  /** 브라우저가 디코딩하지 못하는 이미지(TIFF 등)의 표시용 JPEG */
  fullImage(info: MediaFileInfo): Promise<string> {
    const key = cacheKeyFor(info, 'full');
    return this.cached(key, (out) =>
      this.extract(info.path, null, FULL_IMAGE_MAX_WIDTH, 2, out, false),
    );
  }

  stats(): { bytes: number; count: number } {
    return this.deps.repo.thumbStats();
  }

  clear(): void {
    for (const t of this.deps.repo.allThumbs()) {
      fs.rmSync(t.file, { force: true });
      this.deps.repo.deleteThumb(t.cacheKey);
    }
  }

  /** 상한을 넘으면 오래 쓰지 않은 항목부터 지운다 */
  enforceLimit(): void {
    const limit = this.deps.limitBytes();
    let { bytes } = this.deps.repo.thumbStats();
    while (bytes > limit) {
      const victims = this.deps.repo.oldestThumbs(200);
      if (victims.length === 0) break;
      for (const v of victims) {
        if (bytes <= limit) break;
        fs.rmSync(v.file, { force: true });
        this.deps.repo.deleteThumb(v.cacheKey);
        bytes -= v.bytes;
      }
    }
  }

  // -------------------------------------------------------------------------

  private async cached(key: string, produce: (out: string) => Promise<void>): Promise<string> {
    const hit = this.deps.repo.getThumb(key);
    if (hit && fs.existsSync(hit.file)) {
      this.deps.repo.touchThumb(key, this.now());
      return hit.file;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const task = (async () => {
      await this.acquire();
      try {
        const sub = path.join(this.deps.dir, key.slice(0, 2));
        fs.mkdirSync(sub, { recursive: true });
        const out = path.join(sub, `${key}.jpg`);
        fs.rmSync(out, { force: true });
        await produce(out);
        const bytes = fs.statSync(out).size;
        this.deps.repo.putThumb(key, out, bytes, this.now());
        this.enforceLimit();
        return out;
      } finally {
        this.release();
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  /**
   * 한 프레임을 JPEG 로 뽑는다.
   * seekSec 이 있으면 입력 앞에 -ss 를 두어 정확한 시점으로 간다 (키프레임부터 디코딩해 버리므로 정확하다).
   * 가로 상한만 두고 세로는 비율대로 맞춘다. 회전 메타데이터는 ffmpeg 가 자동 적용한다.
   */
  private async extract(
    input: string,
    seekSec: number | null,
    maxWidth: number,
    quality: number,
    out: string,
    isVideo: boolean,
  ): Promise<void> {
    const tools = this.deps.tools();
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
    if (seekSec !== null) args.push('-ss', seekSec.toFixed(3));
    args.push('-i', input, '-map', '0:v:0', '-frames:v', '1');
    args.push('-vf', `scale='min(${String(maxWidth)},iw)':-2`);
    // 10비트·4:4:4 등은 JPEG 가 받는 yuvj420p 로 맞춘다
    args.push('-pix_fmt', 'yuvj420p', '-q:v', String(quality), '-update', '1', '-f', 'image2', out);
    const res = await this.deps.proc.run(tools.ffmpeg, args, { timeoutMs: CALL_TIMEOUT_MS });
    if (res.exitCode !== 0 || !fs.existsSync(out)) {
      // 영상 끝 근처 시점은 프레임이 없을 수 있다: 시점 없이 첫 프레임으로 한 번 더 시도한다
      if (isVideo && seekSec !== null && seekSec > 0) {
        const retry = await this.deps.proc.run(
          tools.ffmpeg,
          args.filter((a, i, arr) => !(a === '-ss' || (i > 0 && arr[i - 1] === '-ss'))),
          { timeoutMs: CALL_TIMEOUT_MS },
        );
        if (retry.exitCode === 0 && fs.existsSync(out)) return;
      }
      throw new AppError(
        'PREVIEW_FAILED',
        res.stderrTail.slice(-3).join('\n') || `코드 ${String(res.exitCode)}`,
      );
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.deps.concurrency()) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
