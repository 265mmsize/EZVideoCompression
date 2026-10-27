import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MediaRef, MediaSource, PreviewAsset } from '../../shared/types/domain';
import { useAppStore } from '../hooks/useAppStore';
import { formatBytes, formatDuration } from '../format';
import { Button, ProgressBar } from '../components/ui';
import { libraryApi } from './libraryActions';

/**
 * 미디어 플레이어.
 * 우선순위: 직접 재생 → 프레임 보기(시점 슬라이더) → 미리보기 변환본 생성 후 재생.
 * 변환본은 "미리보기용 변환본"으로 표시해 압축 결과와 혼동하지 않게 한다.
 * 참조가 바뀌면 key 로 다시 마운트되어 상태가 초기화된다.
 */
export function MediaPlayer({
  media,
  itemId,
}: {
  media: MediaRef;
  itemId: string | null;
}): ReactNode {
  return (
    <MediaPlayerInner
      key={`${JSON.stringify(media)}|${itemId ?? ''}`}
      media={media}
      itemId={itemId}
    />
  );
}

function MediaPlayerInner({
  media,
  itemId,
}: {
  media: MediaRef;
  itemId: string | null;
}): ReactNode {
  const [source, setSource] = useState<MediaSource | null>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [proxies, setProxies] = useState<PreviewAsset[]>([]);
  const [removedProxy, setRemovedProxy] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const { previews } = useAppStore();
  const progress = creating ? previews[creating] : undefined;
  const refKey = JSON.stringify(media);

  useEffect(() => {
    let alive = true;
    void libraryApi.source(JSON.parse(refKey) as MediaRef).then((s) => {
      if (alive && s) setSource(s);
    });
    if (itemId) {
      void libraryApi.previews(`item:${itemId}`).then((list) => {
        if (alive && list) setProxies(list.filter((p) => p.kind === 'proxy'));
      });
    }
    return () => {
      alive = false;
    };
  }, [refKey, itemId]);

  if (!source) return <div className="p-4 text-sm text-[var(--c-muted)]">미디어를 여는 중…</div>;

  // 생성이 끝난 변환본은 진행 이벤트에서 파생한다 (목록을 다시 읽지 않아도 된다)
  const createdProxy = progress?.status === 'done' ? progress.asset : null;
  const proxy = removedProxy ? null : (createdProxy ?? proxies[0] ?? null);
  const inProgress = creating !== null && (progress === undefined || progress.status === 'running');
  const useDirect = source.capability.direct && !playbackFailed;

  return (
    <div className="space-y-2">
      {source.mediaKind === 'image' ? (
        <img
          src={source.url}
          alt={source.fileName}
          className="max-h-[60vh] w-full bg-black object-contain"
        />
      ) : useDirect ? (
        <video
          key={source.url}
          src={source.url}
          controls
          preload="metadata"
          className="max-h-[60vh] w-full bg-black"
          onError={() => setPlaybackFailed(true)}
        >
          <track kind="captions" />
        </video>
      ) : proxy ? (
        <div className="space-y-1">
          <video
            key={proxy.url}
            src={proxy.url}
            controls
            preload="metadata"
            className="max-h-[60vh] w-full bg-black"
          >
            <track kind="captions" />
          </video>
          <p className="rounded bg-[var(--c-surface-2)] px-2 py-1 text-xs text-[var(--c-warn)]">
            미리보기용 변환본을 재생 중입니다 ({formatBytes(proxy.sizeBytes)}). 압축 결과가
            아닙니다.
          </p>
        </div>
      ) : (
        <FrameViewer media={media} durationSec={source.durationSec} />
      )}

      {(source.capability.reason || playbackFailed) && (
        <p className="text-xs text-[var(--c-muted)]">
          {playbackFailed ? '직접 재생에 실패해 프레임 보기로 전환했습니다. ' : ''}
          {source.capability.reason ?? ''}
        </p>
      )}

      {source.mediaKind === 'video' && itemId && !useDirect && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {inProgress ? (
            <>
              <div className="w-40">
                <ProgressBar ratio={progress?.ratio ?? null} label="변환본 생성 진행률" />
              </div>
              <Button
                onClick={() => {
                  if (creating) void libraryApi.cancelPreview(creating);
                }}
              >
                생성 취소
              </Button>
            </>
          ) : proxy ? (
            <Button
              onClick={() =>
                void libraryApi.removePreview(proxy.id).then(() => setRemovedProxy(true))
              }
            >
              변환본 삭제
            </Button>
          ) : (
            <Button
              onClick={() => {
                setRemovedProxy(false);
                void libraryApi.createProxy(itemId).then((r) => {
                  if (r) setCreating(r.previewId);
                });
              }}
            >
              미리보기 변환본 만들기 (H.264, 최대 1280px·10분)
            </Button>
          )}
          {progress?.status === 'failed' && (
            <span className="text-[var(--c-danger)]">실패: {progress.error}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** 직접 재생이 안 되는 영상의 시점별 프레임 보기 */
export function FrameViewer({
  media,
  durationSec,
}: {
  media: MediaRef;
  durationSec: number | null;
}): ReactNode {
  const [time, setTime] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refKey = JSON.stringify(media);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setLoading(true);
      void libraryApi.frame(JSON.parse(refKey) as MediaRef, time).then((r) => {
        if (r) setUrl(r.url);
        setLoading(false);
      });
    }, 150);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refKey, time]);

  const max = durationSec !== null && durationSec > 0 ? Math.max(0, durationSec - 0.1) : 0;
  return (
    <div className="space-y-1">
      <div className="relative flex min-h-[200px] items-center justify-center bg-black">
        {url ? (
          <img
            src={url}
            alt={`${time.toFixed(1)}초 프레임`}
            className="max-h-[60vh] w-full object-contain"
          />
        ) : null}
        {loading && (
          <span className="absolute right-2 top-2 rounded bg-black/60 px-2 text-xs text-white">
            추출 중
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs">
        <input
          type="range"
          min={0}
          max={max}
          step={0.1}
          value={Math.min(time, max)}
          onChange={(e) => setTime(Number(e.target.value))}
          aria-label="프레임 시점"
          className="flex-1"
        />
        <span className="w-24 text-right text-[var(--c-muted)]">
          {formatDuration(time)} / {formatDuration(durationSec)}
        </span>
      </div>
      <p className="text-xs text-[var(--c-muted)]">
        프레임 보기: 원본 파일에서 해당 시점의 프레임을 추출해 표시합니다 (재생 아님).
      </p>
    </div>
  );
}
