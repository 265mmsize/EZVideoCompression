/**
 * 유튜브 주소 해석과 임베드 주소 생성 (순수 함수).
 * 영상 ID 만 골라 쓰고, 임베드 주소는 이 모듈이 만든 것만 쓴다. 다른 호스트는 받지 않는다.
 */

export interface YouTubeTarget {
  videoId: string;
  startSec: number;
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
export const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/** 시작 위치: 초 숫자(`90`), 또는 `1h2m3s` 형식. 잘못된 값은 0. */
export function parseStart(v: string | null): number {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Number(v);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(v);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * 유튜브 영상 주소를 해석한다. 지원: youtube.com/watch?v=, youtu.be/, /embed/, /shorts/, /live/.
 * https 만 받고, 그 밖의 주소나 잘못된 영상 ID 는 null.
 */
export function parseYouTubeUrl(input: string): YouTubeTarget | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  let id: string | null;
  if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0] ?? null;
  } else if (WATCH_HOSTS.has(host)) {
    if (u.pathname === '/watch') {
      id = u.searchParams.get('v');
    } else {
      id = /^\/(?:embed|shorts|live)\/([^/]+)/.exec(u.pathname)?.[1] ?? null;
    }
  } else {
    return null;
  }
  if (!id || !ID_RE.test(id)) return null;
  return {
    videoId: id,
    startSec: parseStart(u.searchParams.get('t') ?? u.searchParams.get('start')),
  };
}

/** 임베드 주소. 플레이어 명령(postMessage)을 쓰려고 enablejsapi 를 켠다. */
export function embedUrl(t: YouTubeTarget): string {
  const params = new URLSearchParams({
    enablejsapi: '1',
    rel: '0',
    modestbranding: '1',
    playsinline: '1',
  });
  if (t.startSec > 0) params.set('start', String(t.startSec));
  return `${EMBED_ORIGIN}/embed/${t.videoId}?${params.toString()}`;
}
