import type { ReactNode } from 'react';
import type { JobView } from '../../shared/types/domain';
import { formatBytes } from '../format';
import { Button } from './ui';
import { cancelRecommend, recommendJob, updateJobSettings } from '../actions';

/**
 * 샘플 기반 품질 추천 패널.
 * 결과는 "샘플 구간 평가"이며 전체 영상 검증이 아니라는 점을 항상 함께 보여준다.
 * 추천값을 적용하기 전까지 설정은 바뀌지 않는다.
 */
export function RecommendationPanel({ job }: { job: JobView }): ReactNode {
  const rec = job.recommendation;
  const eligible =
    job.status === 'ready' && (job.settings.mode === 'quality' || job.settings.mode === 'fast');

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-[var(--c-muted)]">샘플 품질 추천</h3>
      <p className="text-xs text-[var(--c-muted)]">
        영상 안의 짧은 구간 여러 곳을 인코딩해 화질(SSIM 0~1)과 용량을 비교합니다. 샘플 평가이며
        전체 영상의 품질을 검증한 것이 아닙니다. VMAF 는 사용하지 않습니다. 추천 CRF 는 CPU
        인코더(libx264·libx265)에만 적용되며, 빠른 압축이 하드웨어 인코더를 쓰는 경우에는 적용되지
        않습니다.
      </p>

      {job.sampling ? (
        <div className="flex items-center gap-2 text-sm">
          <span>샘플 분석 중… (최대 2분)</span>
          <Button onClick={() => void cancelRecommend(job.id)}>분석 취소</Button>
        </div>
      ) : (
        <Button disabled={!eligible} onClick={() => void recommendJob(job.id)}>
          {rec ? '샘플 다시 분석' : '샘플로 추천 받기'}
        </Button>
      )}
      {!eligible && !rec && (
        <p className="text-xs text-[var(--c-muted)]">
          고품질 자동 또는 빠른 압축 모드의 준비됨 작업에서 사용할 수 있습니다.
        </p>
      )}

      {rec && (
        <div className="space-y-2 rounded border border-[var(--c-border)] p-3 text-sm">
          <p>
            추천 CRF <strong>{rec.recommendedCrf}</strong>{' '}
            {rec.verdict === 'met' ? (
              <span className="text-[var(--c-ok)]">(샘플 SSIM 기준 {rec.threshold} 충족)</span>
            ) : (
              <span className="text-[var(--c-warn)]">
                (기준 {rec.threshold} 미달 — 가장 높은 화질 후보)
              </span>
            )}
          </p>
          <table className="w-full text-left text-xs">
            <caption className="sr-only">CRF 후보별 샘플 측정</caption>
            <thead className="text-[var(--c-muted)]">
              <tr>
                <th scope="col" className="py-1">
                  CRF
                </th>
                <th scope="col" className="py-1">
                  최소 SSIM
                </th>
                <th scope="col" className="py-1">
                  평균 SSIM
                </th>
                <th scope="col" className="py-1">
                  영상 용량 추정 (샘플 기준)
                </th>
              </tr>
            </thead>
            <tbody>
              {rec.candidates.map((c) => (
                <tr key={c.crf} className={c.crf === rec.recommendedCrf ? 'font-semibold' : ''}>
                  <td className="py-1">{c.crf}</td>
                  <td className="py-1">{c.minSsim.toFixed(3)}</td>
                  <td className="py-1">{c.meanSsim.toFixed(3)}</td>
                  <td className="py-1">
                    {formatBytes(c.estVideoBytesMin)} ~ {formatBytes(c.estVideoBytesMax)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-[var(--c-muted)]">
            구간 {rec.sampleSegments.length}개, 샘플 {rec.sampledSec.toFixed(1)}초, 소요{' '}
            {rec.elapsedSec.toFixed(1)}초. {rec.note}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!eligible || job.settings.crf === rec.recommendedCrf}
              onClick={() => void updateJobSettings(job.id, { crf: rec.recommendedCrf })}
            >
              {job.settings.crf === rec.recommendedCrf
                ? '추천 CRF 적용됨'
                : `추천 CRF ${rec.recommendedCrf} 적용`}
            </Button>
            {job.settings.crf !== null && (
              <Button
                disabled={!eligible}
                onClick={() => void updateJobSettings(job.id, { crf: null })}
              >
                기본값으로 되돌리기
              </Button>
            )}
          </div>
          <p className="text-xs text-[var(--c-muted)]">
            추정 용량은 샘플 비트레이트로 계산한 범위이며 확정값이 아닙니다. 실제 결과는 인코딩 후
            검증 뒤에 확정됩니다.
          </p>
        </div>
      )}
    </section>
  );
}
