import type { ReactNode } from 'react';

/**
 * 비교 화면은 3단계(샘플 인코딩·비교) 범위다. 아직 구현하지 않았으므로 기능이 있는 것처럼 보이는 요소를 두지 않는다.
 */
export function ComparePage(): ReactNode {
  return (
    <div className="space-y-3 p-4">
      <h1 className="text-lg font-semibold">비교</h1>
      <div className="rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-6 text-sm">
        <p className="font-medium">원본·결과 비교는 아직 구현되지 않았습니다.</p>
        <p className="mt-2 text-[var(--c-muted)]">
          같은 시점의 원본과 결과 프레임 비교, 샘플 품질 지표는 3단계(품질 추천)에서 제공할
          예정입니다. 지금은 작업 목록의 상세 화면에서 결과 파일의 위치와 검증 결과를 확인할 수
          있습니다.
        </p>
      </div>
    </div>
  );
}
