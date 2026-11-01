/**
 * 유튜브 재생 화면. 설정에서 "유튜브 임베드 재생"을 켠 경우에만 플레이어를 띄운다.
 * 영상은 파일로 받지 않고 플레이어에서 스트리밍으로만 재생한다.
 * 유튜브 뮤직은 공식 임베드 재생이 없으므로 기본 브라우저에서 연다.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../components/ui';
import { formatDuration } from '../format';
import {
  currentTimeFromMessage,
  LISTENING_MESSAGE,
  playerCommand,
  type PlayerFunc,
} from './playerMessages';
import { EMBED_ORIGIN, embedUrl, parseYouTubeUrl, type YouTubeTarget } from './youtubeUrl';

export function YouTubePage({
  embedEnabled,
  onOpenSettings,
}: {
  embedEnabled: boolean;
  onOpenSettings: () => void;
}): ReactNode {
  const [text, setText] = useState('');
  const [target, setTarget] = useState<YouTubeTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // 플레이어가 보내는 현재 재생 시각만 받는다 (임베드 출처와 우리 프레임에서 온 것만)
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== EMBED_ORIGIN) return;
      if (e.source !== frameRef.current?.contentWindow) return;
      const t = currentTimeFromMessage(e.data);
      if (t !== null) setNow(t);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const post = (func: PlayerFunc, args: unknown[] = []): void => {
    frameRef.current?.contentWindow?.postMessage(playerCommand(func, args), EMBED_ORIGIN);
  };

  const open = (): void => {
    const t = parseYouTubeUrl(text);
    if (!t) {
      setTarget(null);
      setError(
        '유튜브 영상 주소가 아닙니다. youtube.com/watch?v=… 또는 youtu.be/… 형식을 넣으세요.',
      );
      return;
    }
    setError(null);
    setTarget(t);
    setNow(t.startSec);
  };

  const seekBy = (delta: number): void => {
    const next = Math.max(0, now + delta);
    setNow(next);
    post('seekTo', [next, true]);
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 text-sm">
      <section className="space-y-2">
        <h2 className="text-base font-semibold">유튜브 재생</h2>
        {!embedEnabled && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded border border-[var(--c-border)] p-3"
          >
            <span>
              유튜브 임베드 재생이 꺼져 있습니다. 설정에서 "유튜브 임베드 재생 허용"을 켜야 재생할
              수 있습니다. 켜면 유튜브 서버에 접속합니다.
            </span>
            <Button onClick={onOpenSettings}>설정 열기</Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="유튜브 주소"
            className="min-w-0 flex-1 rounded border border-[var(--c-border)] bg-[var(--c-surface)] px-2 py-1"
            placeholder="https://www.youtube.com/watch?v=…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') open();
            }}
          />
          <Button variant="primary" onClick={open}>
            재생 준비
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-[var(--c-danger)]">
            {error}
          </p>
        )}
        {embedEnabled && target && (
          <div className="space-y-2">
            <iframe
              key={target.videoId}
              ref={frameRef}
              title="유튜브 플레이어"
              src={embedUrl(target)}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              className="aspect-video w-full rounded bg-black"
              onLoad={() =>
                frameRef.current?.contentWindow?.postMessage(LISTENING_MESSAGE, EMBED_ORIGIN)
              }
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => post('playVideo')}>재생</Button>
              <Button onClick={() => post('pauseVideo')}>일시정지</Button>
              <Button onClick={() => seekBy(-10)}>-10초</Button>
              <Button onClick={() => seekBy(10)}>+10초</Button>
              <span className="tabular-nums text-[var(--c-muted)]">위치 {formatDuration(now)}</span>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-2 border-t border-[var(--c-border)] pt-4">
        <h2 className="text-base font-semibold">YouTube Music</h2>
        <p className="text-[var(--c-muted)]">
          유튜브 뮤직은 앱 안에서 재생하지 않습니다. 공식 임베드 재생을 제공하지 않아서 기본
          브라우저에서 엽니다.
        </p>
        <Button onClick={() => window.open('https://music.youtube.com/', '_blank', 'noopener')}>
          기본 브라우저에서 YouTube Music 열기
        </Button>
      </section>
    </div>
  );
}
