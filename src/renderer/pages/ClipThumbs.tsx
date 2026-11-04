/**
 * 타임라인 클립 안의 썸네일. 클립 폭에 맞춰 원본 프레임을 고르게 읽어 배경으로 깐다.
 * 같은 프레임은 한 번만 읽도록 캐시한다. 프레임은 하나씩 차례로 읽는다.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { EditClip } from '../../shared/types/domain';
import { libraryApi } from '../library/libraryActions';
import { thumbCount, thumbTimes } from './thumbMath';

const cache = new Map<string, Promise<string | null>>();

function frameUrl(path: string, t: number): Promise<string | null> {
  const key = `${path}|${t.toFixed(2)}`;
  let p = cache.get(key);
  if (!p) {
    p = libraryApi.editFrame(path, t);
    cache.set(key, p);
  }
  return p;
}

/** 클립 폭이나 원본 구간이 바뀌면 키가 달라져 새로 읽는다 */
export function ClipThumbs({ clip, widthPx }: { clip: EditClip; widthPx: number }): ReactNode {
  const count = thumbCount(widthPx);
  const key = thumbTimes(clip, count)
    .map((t) => t.toFixed(2))
    .join(',');
  return <ThumbStrip key={`${clip.path}|${key}`} path={clip.path} times={key} />;
}

function ThumbStrip({ path, times }: { path: string; times: string }): ReactNode {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  useEffect(() => {
    const live = { on: true };
    void (async () => {
      const out: (string | null)[] = [];
      for (const t of times.split(',').map(Number)) {
        const u = await frameUrl(path, t);
        if (!live.on) return;
        out.push(u);
        setUrls([...out]);
      }
    })();
    return () => {
      live.on = false;
    };
  }, [path, times]);
  return (
    <div
      className="pointer-events-none absolute inset-0 flex overflow-hidden opacity-60"
      aria-hidden
    >
      {urls.map((u, i) =>
        u ? (
          <img key={i} src={u} alt="" className="h-full min-w-0 flex-1 object-cover" />
        ) : (
          <div key={i} className="h-full flex-1" />
        ),
      )}
    </div>
  );
}
