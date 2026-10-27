/**
 * 미디어 토큰 레지스트리.
 *
 * 렌더러는 로컬 경로를 알 수 없고 알 필요도 없다. 메인이 "키 → 토큰" 을 발급하고,
 * 전용 프로토콜(vslim-media://file/<토큰>)은 등록된 토큰만 실제 파일로 해석한다.
 * 같은 키에는 같은 토큰을 돌려주므로 렌더러가 URL 을 캐시해도 된다.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const MEDIA_SCHEME = 'vslim-media';

export interface MediaEntry {
  path: string;
  mime: string;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

export function mimeOf(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export class MediaTokenRegistry {
  private readonly byToken = new Map<string, MediaEntry>();
  private readonly byKey = new Map<string, string>();

  /** 키에 대한 토큰 URL 을 발급한다. 같은 키에 다른 경로가 오면 이전 토큰을 무효화한다. */
  issue(key: string, filePath: string, mime: string = mimeOf(filePath)): string {
    const existing = this.byKey.get(key);
    if (existing) {
      const entry = this.byToken.get(existing);
      if (entry && entry.path === filePath) return this.url(existing);
      this.byToken.delete(existing);
    }
    const token = randomBytes(16).toString('hex');
    this.byToken.set(token, { path: filePath, mime });
    this.byKey.set(key, token);
    return this.url(token);
  }

  resolve(token: string): MediaEntry | null {
    return this.byToken.get(token) ?? null;
  }

  revokeKey(key: string): void {
    const token = this.byKey.get(key);
    if (token) this.byToken.delete(token);
    this.byKey.delete(key);
  }

  /** 접두사로 시작하는 키를 모두 무효화한다 (항목 제거 시) */
  revokePrefix(prefix: string): void {
    for (const key of [...this.byKey.keys()]) {
      if (key.startsWith(prefix)) this.revokeKey(key);
    }
  }

  get size(): number {
    return this.byToken.size;
  }

  private url(token: string): string {
    return `${MEDIA_SCHEME}://file/${token}`;
  }
}

/** URL 에서 토큰을 꺼낸다. 형식이 다르면 null. */
export function tokenFromUrl(url: string): string | null {
  const m = new RegExp(`^${MEDIA_SCHEME}://file/([0-9a-f]{32})(?:[?#].*)?$`).exec(url);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Range 요청 처리 (순수 함수: 테스트 가능)
// ---------------------------------------------------------------------------

export interface RangeSpec {
  start: number;
  end: number;
}

/**
 * HTTP Range 헤더를 해석한다. 단일 범위만 지원한다.
 * - null: 헤더 없음 (전체 응답)
 * - 'invalid': 만족할 수 없는 범위 (416)
 */
export function parseRange(header: string | null, size: number): RangeSpec | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  let start: number;
  let end: number;
  if (a === '') {
    // 끝에서 N 바이트
    const n = Number(b);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'invalid';
  }
  return { start, end };
}

export interface MediaResponsePlan {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  range: RangeSpec | null;
}

/** 응답 상태와 헤더를 정한다. 본문 스트림은 호출자가 range 로 만든다. */
export function planMediaResponse(
  rangeHeader: string | null,
  size: number,
  mime: string,
): MediaResponsePlan {
  const base: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') {
    return {
      status: 416,
      headers: { ...base, 'Content-Range': `bytes */${String(size)}` },
      range: null,
    };
  }
  if (range === null) {
    return { status: 200, headers: { ...base, 'Content-Length': String(size) }, range: null };
  }
  return {
    status: 206,
    headers: {
      ...base,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
    },
    range,
  };
}
