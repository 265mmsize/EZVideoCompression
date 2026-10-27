import { useEffect, useState, type ReactNode } from 'react';
import type { JobView, PreviewAsset } from '../../shared/types/domain';
import { MODE_LABELS } from '../../shared/contracts/ipc';
import { useAppStore } from '../hooks/useAppStore';
import { call } from '../api';
import { formatBytes, formatDuration, formatSavings } from '../format';
import { Button, ProgressBar } from '../components/ui';
import { ComparePane } from '../library/ComparePane';
import { libraryApi } from '../library/libraryActions';

/**
 * 비교 화면.
 *  1) 완료된 작업의 원본·결과를 같은 시점으로 비교한다.
 *  2) 설정 미리보기: 준비됨 작업의 현재 설정으로 짧은 구간을 실제 인코딩해 원본과 비교한다 (HandBrake 방식).
 */
export function ComparePage({ initialJobId }: { initialJobId: string | null }): ReactNode {
  // initialJobId 가 바뀌면 key 로 다시 마운트되어 선택이 초기화된다 (App 에서 key 지정)
  const { jobs, previews } = useAppStore();
  const [history, setHistory] = useState<JobView[]>([]);
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [start, setStart] = useState(0);
  const [dur, setDur] = useState(5);
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    call('history:list', { limit: 200, offset: 0 })
      .then((r) => setHistory(r.items))
      .catch(() => undefined);
  }, [jobs]);

  const all = [...jobs, ...history.filter((h) => !jobs.some((j) => j.id === h.id))];
  const job = all.find((j) => j.id === jobId) ?? null;
  const completed = all.filter((j) => j.outputPath);
  const readyForPreview = jobs.filter(
    (j) => j.status === 'ready' && j.settings.mode !== 'copy' && j.analysis?.support !== 'blocked',
  );
  const progress = previewId ? previews[previewId] : undefined;
  const asset: PreviewAsset | null = progress?.status === 'done' ? progress.asset : null;

  const createPreview = async (): Promise<void> => {
    if (!job) return;
    const r = await libraryApi.createSettingsPreview(job.id, start, dur);
    if (r) setPreviewId(r.previewId);
  };

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">비교</h1>

      <section className="space-y-2 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
        <h2 className="text-sm font-semibold">작업 선택</h2>
        <select
          className="w-full max-w-xl rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5 text-sm"
          value={jobId ?? ''}
          onChange={(e) => {
            setJobId(e.target.value || null);
            setPreviewId(null);
          }}
          aria-label="비교할 작업"
        >
          <option value="">작업을 선택하세요</option>
          <optgroup label="완료된 작업 (원본·결과 비교)">
            {completed.map((j) => (
              <option key={j.id} value={j.id}>
                {j.fileName} · {formatBytes(j.inputSizeBytes)} → {formatBytes(j.outputSizeBytes)} (
                {formatSavings(j.savingsRatio)})
              </option>
            ))}
          </optgroup>
          <optgroup label="준비된 작업 (설정 미리보기)">
            {readyForPreview.map((j) => (
              <option key={j.id} value={j.id}>
                {j.fileName} · {MODE_LABELS[j.settings.mode]} / {j.settings.codec.toUpperCase()}
              </option>
            ))}
          </optgroup>
        </select>
        {!job && (
          <p className="text-xs text-[var(--c-muted)]">
            완료된 작업은 원본과 결과를, 준비된 작업은 현재 설정으로 인코딩한 구간을 원본과
            비교합니다.
          </p>
        )}
      </section>

      {job?.outputPath && (
        <section className="space-y-2 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
          <h2 className="text-sm font-semibold">원본 · 결과 비교</h2>
          <p className="text-xs text-[var(--c-muted)]">
            원본 {formatBytes(job.inputSizeBytes)} → 결과 {formatBytes(job.outputSizeBytes)} (
            {formatSavings(job.savingsRatio)}) · {job.encoderName ?? ''}
            {job.recommendation
              ? ` · 샘플 추천 CRF ${String(job.recommendation.recommendedCrf)} (SSIM 최소 ${job.recommendation.candidates.find((c) => c.crf === job.recommendation?.recommendedCrf)?.minSsim.toFixed(3) ?? '-'})`
              : ''}
          </p>
          <ComparePane
            key={job.id}
            left={{
              label: '원본',
              ref: { kind: 'job', jobId: job.id, side: 'input' },
              offsetSec: 0,
            }}
            right={{
              label: '결과',
              ref: { kind: 'job', jobId: job.id, side: 'output' },
              offsetSec: 0,
            }}
            durationSec={job.probe?.durationSec.value ?? null}
          />
        </section>
      )}

      {job && !job.outputPath && (
        <section className="space-y-2 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
          <h2 className="text-sm font-semibold">설정 미리보기 (구간 실제 인코딩)</h2>
          <p className="text-xs text-[var(--c-muted)]">
            현재 설정: {MODE_LABELS[job.settings.mode]} · {job.settings.codec.toUpperCase()} ·{' '}
            {job.settings.container.toUpperCase()}
            {job.settings.crf !== null ? ` · CRF ${String(job.settings.crf)}` : ''}. 결과는
            미리보기로만 저장되며 압축 결과가 아닙니다.
          </p>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col text-xs">
              시작 (초)
              <input
                type="number"
                min={0}
                step={0.5}
                max={Math.max(0, (job.probe?.durationSec.value ?? 0) - 1)}
                value={start}
                onChange={(e) => setStart(Number(e.target.value))}
                className="w-28 rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              />
            </label>
            <label className="flex flex-col text-xs">
              길이 (초, 최대 60)
              <input
                type="number"
                min={1}
                max={60}
                step={1}
                value={dur}
                onChange={(e) => setDur(Number(e.target.value))}
                className="w-28 rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              />
            </label>
            <span className="text-xs text-[var(--c-muted)]">
              영상 길이 {formatDuration(job.probe?.durationSec.value ?? null)}
            </span>
            <Button
              variant="primary"
              disabled={progress?.status === 'running'}
              onClick={() => void createPreview()}
            >
              미리보기 인코딩
            </Button>
            {progress?.status === 'running' && (
              <>
                <div className="w-40">
                  <ProgressBar ratio={progress.ratio} label="설정 미리보기 진행률" />
                </div>
                <Button
                  onClick={() => {
                    if (previewId) void libraryApi.cancelPreview(previewId);
                  }}
                >
                  취소
                </Button>
              </>
            )}
            {progress?.status === 'failed' && (
              <span className="text-xs text-[var(--c-danger)]">실패: {progress.error}</span>
            )}
          </div>
          {asset && (
            <>
              <p className="text-xs">
                {asset.note} · 결과 {formatBytes(asset.sizeBytes)}
                {asset.durationSec
                  ? ` (${asset.durationSec.toFixed(1)}초, 약 ${String(Math.round((asset.sizeBytes * 8) / asset.durationSec / 1000))} kbps)`
                  : ''}
              </p>
              <ComparePane
                key={asset.id}
                left={{
                  label: '원본',
                  ref: { kind: 'job', jobId: job.id, side: 'input' },
                  offsetSec: asset.startSec ?? start,
                }}
                right={{ label: '설정 적용', ref: { kind: 'preview', id: asset.id }, offsetSec: 0 }}
                durationSec={asset.durationSec}
              />
            </>
          )}
        </section>
      )}
    </div>
  );
}
