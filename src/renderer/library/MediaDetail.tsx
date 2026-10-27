import { useState, type ReactNode } from 'react';
import type { LibraryItem, MediaLabel } from '../../shared/types/domain';
import { MEDIA_LABELS } from '../../shared/types/domain';
import { formatBytes, formatDuration, formatSavings } from '../format';
import { Button } from '../components/ui';
import { MediaPlayer } from './MediaPlayer';
import { LABEL_COLORS, LABEL_NAMES, libraryApi } from './libraryActions';

/** 오른쪽 상세 패널: 미리보기·재생, 정보, 평점·라벨·태그·메모, 압축 연결 */
export function MediaDetail({
  item,
  onChanged,
  onClose,
  onCompare,
}: {
  item: LibraryItem;
  onChanged: (it: LibraryItem) => void;
  onClose: () => void;
  onCompare: (jobId: string) => void;
}): ReactNode {
  const [tagsText, setTagsText] = useState(item.tags.join(', '));
  const [note, setNote] = useState(item.note ?? '');

  const apply = async (patch: Parameters<typeof libraryApi.setMeta>[1]): Promise<void> => {
    const updated = await libraryApi.setMeta(item.id, patch);
    if (updated) onChanged(updated);
  };

  return (
    <aside
      aria-label="미디어 상세"
      className="flex h-full w-[440px] shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-3"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold" title={item.path}>
            {item.fileName}
          </h2>
          <p className="truncate text-xs text-[var(--c-muted)]" title={item.parentDir}>
            {item.parentDir}
          </p>
        </div>
        <Button onClick={onClose} aria-label="상세 닫기">
          닫기
        </Button>
      </header>

      {item.missing ? (
        <p className="rounded border border-[var(--c-warn)] p-2 text-sm">
          파일을 찾을 수 없습니다. 이동·삭제되었을 수 있습니다. 폴더를 다시 인덱싱하면 상태가
          갱신됩니다.
        </p>
      ) : item.errorCode ? (
        <p className="rounded border border-[var(--c-danger)] p-2 text-sm">
          분석 실패({item.errorCode}): 손상되었거나 지원하지 않는 파일입니다.
        </p>
      ) : (
        <MediaPlayer media={{ kind: 'item', id: item.id }} itemId={item.id} />
      )}

      <section>
        <h3 className="mb-1 text-xs font-semibold text-[var(--c-muted)]">정보</h3>
        <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs">
          <dt className="text-[var(--c-muted)]">종류</dt>
          <dd>{item.kind === 'video' ? '영상' : '이미지'}</dd>
          <dt className="text-[var(--c-muted)]">크기</dt>
          <dd>{formatBytes(item.sizeBytes)}</dd>
          <dt className="text-[var(--c-muted)]">해상도</dt>
          <dd>
            {item.width && item.height ? `${String(item.width)}×${String(item.height)}` : '-'}
          </dd>
          {item.kind === 'video' && (
            <>
              <dt className="text-[var(--c-muted)]">길이</dt>
              <dd>{formatDuration(item.durationSec)}</dd>
            </>
          )}
          <dt className="text-[var(--c-muted)]">코덱</dt>
          <dd>
            {item.videoCodec ?? '-'}
            {item.audioCodec ? ` / ${item.audioCodec}` : ''}
          </dd>
          <dt className="text-[var(--c-muted)]">컨테이너</dt>
          <dd className="truncate">{item.container ?? '-'}</dd>
          <dt className="text-[var(--c-muted)]">수정</dt>
          <dd>{new Date(item.mtimeMs).toLocaleString('ko-KR')}</dd>
        </dl>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold text-[var(--c-muted)]">
          평점·라벨 (앱에만 저장, 파일은 수정하지 않음)
        </h3>
        <div className="flex items-center gap-1" role="radiogroup" aria-label="평점">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={item.rating === n}
              aria-label={`${String(n)}점`}
              onClick={() => void apply({ rating: item.rating === n ? 0 : n })}
              className={`text-lg ${n <= item.rating ? 'text-[var(--c-warn)]' : 'text-[var(--c-border)]'}`}
            >
              ★
            </button>
          ))}
          <span className="ml-2 text-xs text-[var(--c-muted)]">
            {item.rating === 0 ? '없음' : `${String(item.rating)}점`}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1" role="radiogroup" aria-label="라벨">
          {MEDIA_LABELS.map((l: MediaLabel) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={item.label === l}
              aria-label={LABEL_NAMES[l]}
              onClick={() => void apply({ label: item.label === l ? null : l })}
              className={`h-5 w-5 rounded-full border-2 ${item.label === l ? 'border-[var(--c-text)]' : 'border-transparent'}`}
              style={{ background: LABEL_COLORS[l] }}
            />
          ))}
        </div>
      </section>

      <section>
        <label className="text-xs font-semibold text-[var(--c-muted)]">
          태그 (쉼표로 구분)
          <input
            className="mt-1 w-full rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5 text-sm font-normal"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            onBlur={() => {
              void libraryApi
                .setTags(
                  item.id,
                  tagsText
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                )
                .then((u) => {
                  if (u) onChanged(u);
                });
            }}
          />
        </label>
        <label className="mt-2 block text-xs font-semibold text-[var(--c-muted)]">
          메모
          <textarea
            className="mt-1 w-full rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5 text-sm font-normal"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => void apply({ note: note.trim() === '' ? null : note })}
          />
        </label>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold text-[var(--c-muted)]">압축</h3>
        {item.compression ? (
          <div className="text-xs">
            <p>
              작업 상태: {item.compression.status}
              {item.compression.outputSizeBytes !== null
                ? ` · 결과 ${formatBytes(item.compression.outputSizeBytes)} (${formatSavings(item.compression.savingsRatio)})`
                : ''}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {item.compression.outputPath && (
                <Button onClick={() => onCompare(item.compression?.jobId ?? '')}>
                  원본·결과 비교
                </Button>
              )}
              {item.compression.outputPath && (
                <Button
                  onClick={() => void libraryApi.showInFolder(item.compression?.outputPath ?? '')}
                >
                  결과 위치 열기
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-[var(--c-muted)]">아직 압축 작업이 없습니다.</p>
        )}
        <div className="mt-1 flex flex-wrap gap-1">
          {item.kind === 'video' && !item.missing && (
            <Button variant="primary" onClick={() => void libraryApi.enqueue([item.id])}>
              압축 대기열에 추가
            </Button>
          )}
          <Button onClick={() => void libraryApi.showInFolder(item.path)}>탐색기에서 열기</Button>
        </div>
      </section>
    </aside>
  );
}
