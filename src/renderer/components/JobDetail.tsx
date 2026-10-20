import { Fragment, useState, type ReactNode } from 'react';
import type { JobSettings, JobView, Limitation } from '../../shared/types/domain';
import {
  COMPRESSION_MODES,
  OUTPUT_CONTAINERS,
  PRESETS,
  VIDEO_CODECS,
} from '../../shared/types/domain';
import { MODE_LABELS } from '../../shared/contracts/ipc';
import { formatBytes, formatDuration, formatSavings } from '../format';
import { ErrorBlock, Button, SupportBadge, StatusBadge } from './ui';
import {
  cancelJob,
  removeJob,
  retryJob,
  showInFolder,
  startQueue,
  updateJobSettings,
} from '../actions';

const PRESET_LABEL: Record<JobSettings['preset'], string> = {
  compatibility: '호환성 우선',
  space: '저장 공간 우선',
  speed: '처리 속도 우선',
};

const CODEC_NOTE: Record<JobSettings['codec'], string> = {
  h264: 'H.264: 거의 모든 기기에서 재생됩니다. 용량이 H.265 보다 큽니다.',
  hevc: 'H.265: 같은 화질에서 용량이 작지만, 오래된 기기·브라우저에서 재생되지 않을 수 있습니다.',
};

export function JobDetail({ job, onClose }: { job: JobView; onClose: () => void }): ReactNode {
  const probe = job.probe;
  const analysis = job.analysis;
  const editable = job.status === 'ready';
  const [targetText, setTargetText] = useState(
    job.settings.targetMiB !== null ? String(job.settings.targetMiB) : '',
  );

  const update = (patch: Partial<JobSettings>): void => {
    void updateJobSettings(job.id, patch);
  };

  return (
    <aside
      aria-label="파일 상세"
      className="w-[420px] shrink-0 space-y-4 overflow-y-auto rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-4"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold" title={job.inputPath}>
            {job.fileName}
          </h2>
          <p className="text-xs text-[var(--c-muted)]">
            원본 {formatBytes(job.inputSizeBytes)} · <StatusBadge status={job.status} />
          </p>
        </div>
        <Button onClick={onClose} aria-label="상세 닫기">
          닫기
        </Button>
      </header>

      <ErrorBlock code={job.errorCode} detail={job.errorDetail} />

      {probe && (
        <Section title="영상 정보">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <Item k="컨테이너" v={probe.formatName} />
            <Item k="길이" v={formatDuration(probe.durationSec.value)} />
            <Item
              k="전체 비트레이트"
              v={
                probe.bitRate.value
                  ? `${String(Math.round(probe.bitRate.value / 1000))} kbps`
                  : '알 수 없음'
              }
            />
            <Item k="파일 크기" v={formatBytes(probe.sizeBytes)} />
            {probe.streams
              .filter((s) => s.kind === 'video')
              .slice(0, 1)
              .map((v) => (
                <Fragment key={v.index}>
                  <Item k="영상 코덱" v={v.codecName} />
                  <Item
                    k="해상도"
                    v={
                      v.width && v.height ? `${String(v.width)}×${String(v.height)}` : '알 수 없음'
                    }
                  />
                  <Item
                    k="픽셀 포맷"
                    v={`${v.pixFmt ?? '알 수 없음'} (${String(v.bitDepth ?? '?')}비트)`}
                  />
                  <Item k="프레임레이트" v={fps(v.avgFrameRate.value, v.nominalFrameRate.value)} />
                  <Item k="회전" v={`${String(v.rotation)}°`} />
                  <Item k="색 전달 특성" v={v.colorTransfer ?? '정보 없음'} />
                  <Item
                    k="인터레이스"
                    v={
                      v.fieldOrder === 'unknown'
                        ? '알 수 없음'
                        : v.fieldOrder === 'interlaced'
                          ? '인터레이스'
                          : '순차'
                    }
                  />
                </Fragment>
              ))}
          </dl>
          <p className="mt-2 text-xs text-[var(--c-muted)]">
            프레임레이트 차이만으로 가변 프레임률(VFR)을 단정하지 않습니다. 재인코딩은 원본
            타임스탬프를 유지하도록 설정됩니다.
          </p>
        </Section>
      )}

      {analysis && (
        <Section title="지원 여부">
          <div className="mb-2 flex items-center gap-2">
            <SupportBadge level={analysis.support} />
          </div>
          <LimitList items={analysis.limitations} />
        </Section>
      )}

      {analysis && (
        <Section title="트랙 처리 정책">
          <ul className="space-y-1 text-sm">
            {analysis.tracks.map((t) => (
              <li key={t.streamIndex} className="rounded border border-[var(--c-border)] p-2">
                <span className="font-medium">{t.label}</span>
                <span className="ml-2 rounded bg-[var(--c-surface-2)] px-1.5 text-xs">
                  {actionLabel(t.action)}
                </span>
                <p className="mt-0.5 text-xs text-[var(--c-muted)]">{t.reason}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="출력 설정">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="col-span-2 flex flex-col gap-1">
            압축 모드
            <select
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              disabled={!editable}
              value={job.settings.mode}
              onChange={(e) => update({ mode: e.target.value as JobSettings['mode'] })}
            >
              {COMPRESSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            프리셋
            <select
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              disabled={!editable || job.settings.mode === 'copy'}
              value={job.settings.preset}
              onChange={(e) => update({ preset: e.target.value as JobSettings['preset'] })}
            >
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {PRESET_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            출력 컨테이너
            <select
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              disabled={!editable}
              value={job.settings.container}
              onChange={(e) => update({ container: e.target.value as JobSettings['container'] })}
            >
              {OUTPUT_CONTAINERS.map((c) => (
                <option key={c} value={c}>
                  {c.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            영상 코덱
            <select
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              disabled={!editable || job.settings.mode === 'copy'}
              value={job.settings.codec}
              onChange={(e) => update({ codec: e.target.value as JobSettings['codec'] })}
            >
              {VIDEO_CODECS.map((c) => (
                <option key={c} value={c}>
                  {c === 'h264' ? 'H.264' : 'H.265'}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            목표 용량 (MB)
            <input
              type="number"
              min={1}
              step={1}
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              disabled={!editable || job.settings.mode !== 'target'}
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
              onBlur={() => {
                const n = Number(targetText);
                if (Number.isFinite(n) && n > 0) update({ targetMiB: n });
              }}
            />
            <span className="text-xs text-[var(--c-muted)]">MB = MiB (1,048,576 바이트)</span>
          </label>
          {probe && probe.streams.some((s) => s.kind === 'video' && !s.isAttachedPic) && (
            <label className="flex flex-col gap-1">
              주 영상 트랙
              <select
                className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
                disabled={!editable}
                value={job.settings.videoStreamIndex ?? ''}
                onChange={(e) =>
                  update({
                    videoStreamIndex: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              >
                <option value="">자동 선택</option>
                {probe.streams
                  .filter((s) => s.kind === 'video' && !s.isAttachedPic)
                  .map((s) => (
                    <option key={s.index} value={s.index}>
                      #{s.index} · {s.codecName}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
        <p className="mt-2 text-xs text-[var(--c-muted)]">
          {job.settings.mode === 'copy'
            ? '원본 유지: 영상은 재인코딩하지 않으며 컨테이너 변경만으로 용량이 크게 줄지 않을 수 있습니다.'
            : CODEC_NOTE[job.settings.codec]}
        </p>
        {!editable && (
          <p className="mt-1 text-xs text-[var(--c-muted)]">
            설정은 분석이 끝난 대기 작업(준비됨)에서만 바꿀 수 있습니다.
          </p>
        )}
      </Section>

      {analysis && (
        <Section title="예상 결과">
          <p className="text-sm">
            {analysis.expected.kind === 'unknown'
              ? '알 수 없음'
              : analysis.expected.kind === 'estimated'
                ? '추정'
                : '확정'}
            {analysis.expected.maxBytes ? ` · 최대 ${formatBytes(analysis.expected.maxBytes)}` : ''}
          </p>
          <p className="mt-1 text-xs text-[var(--c-muted)]">{analysis.expected.note}</p>
          <p className="mt-2 text-sm">
            처리 시간:{' '}
            {analysis.timeEstimate.kind === 'history' && analysis.timeEstimate.seconds !== null
              ? `약 ${String(Math.round(analysis.timeEstimate.seconds / 60))}분 (추정)`
              : '예측 없음'}
          </p>
          <p className="text-xs text-[var(--c-muted)]">{analysis.timeEstimate.note}</p>
        </Section>
      )}

      {job.validation && (
        <Section title="검증 결과">
          <p className="mb-1 text-xs text-[var(--c-muted)]">
            {job.validation.basicOnly
              ? '기본 검증만 수행했습니다 (전체 프레임 디코딩은 하지 않음).'
              : '전체 프레임 검증 완료'}
          </p>
          <ul className="space-y-1 text-sm">
            {job.validation.checks.map((c) => (
              <li key={c.id} className="flex gap-2">
                <span
                  aria-hidden="true"
                  className={c.passed ? 'text-[var(--c-ok)]' : 'text-[var(--c-danger)]'}
                >
                  {c.passed ? '✓' : '✗'}
                </span>
                <span>
                  <span className="font-medium">{c.label}</span>{' '}
                  <span className="text-[var(--c-muted)]">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(job.outputPath || job.savingsRatio !== null) && (
        <Section title="결과">
          {job.outputPath && <p className="break-all text-sm">{job.outputPath}</p>}
          <p className="text-sm">
            결과 {formatBytes(job.outputSizeBytes)} · {formatSavings(job.savingsRatio)}
          </p>
          {job.encoderName && (
            <p className="text-xs text-[var(--c-muted)]">
              인코더: {job.encoderName}{' '}
              {job.encoderVersion ? `· ${job.encoderVersion.split(' ').slice(0, 3).join(' ')}` : ''}
            </p>
          )}
        </Section>
      )}

      <div className="flex flex-wrap gap-2">
        {job.status === 'ready' && (
          <Button
            variant="primary"
            disabled={analysis?.support === 'blocked'}
            onClick={() => void startQueue([job.id])}
          >
            대기열에 추가
          </Button>
        )}
        {(job.status === 'encoding' || job.status === 'validating') && (
          <Button variant="danger" onClick={() => void cancelJob(job.id)}>
            취소
          </Button>
        )}
        {['failed', 'cancelled', 'interrupted', 'completed', 'no_savings'].includes(job.status) && (
          <Button onClick={() => void retryJob(job.id)}>다시 처리</Button>
        )}
        {job.outputPath && (
          <Button onClick={() => void showInFolder(job.outputPath as string)}>
            결과 위치 열기
          </Button>
        )}
        {[
          'ready',
          'queued',
          'completed',
          'no_savings',
          'failed',
          'cancelled',
          'interrupted',
        ].includes(job.status) && (
          <Button onClick={() => void removeJob(job.id)}>목록에서 제거 (원본 유지)</Button>
        )}
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-[var(--c-muted)]">{title}</h3>
      {children}
    </section>
  );
}

function Item({ k, v }: { k: string; v: string }): ReactNode {
  return (
    <>
      <dt className="text-[var(--c-muted)]">{k}</dt>
      <dd className="truncate">{v}</dd>
    </>
  );
}

function LimitList({ items }: { items: Limitation[] }): ReactNode {
  if (items.length === 0)
    return <p className="text-sm text-[var(--c-muted)]">특별한 제한이 없습니다.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {items.map((l) => (
        <li key={`${l.code}-${l.message}`} className="flex gap-2">
          <span
            aria-hidden="true"
            className={
              l.severity === 'blocking'
                ? 'text-[var(--c-danger)]'
                : l.severity === 'warning'
                  ? 'text-[var(--c-warn)]'
                  : 'text-[var(--c-info)]'
            }
          >
            {l.severity === 'blocking' ? '■' : l.severity === 'warning' ? '▲' : '●'}
          </span>
          <span>{l.message}</span>
        </li>
      ))}
    </ul>
  );
}

function actionLabel(a: string): string {
  switch (a) {
    case 'copy':
      return '복사';
    case 'encode':
      return '재인코딩';
    case 'transcode':
      return '변환';
    case 'exclude':
      return '제외';
    default:
      return '유지';
  }
}

function fps(avg: number | null, nominal: number | null): string {
  if (avg === null && nominal === null) return '알 수 없음';
  const a = avg !== null ? `${avg.toFixed(3)} fps` : '알 수 없음';
  if (nominal !== null && avg !== null && Math.abs(nominal - avg) > 0.01)
    return `${a} (명목 ${nominal.toFixed(3)})`;
  return a;
}
