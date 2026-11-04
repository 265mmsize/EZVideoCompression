/**
 * 영상 편집 원본의 색 범위 판정 (순수 함수).
 * 편집 결과는 SDR 8비트(BT.709)로 만든다. HDR(PQ·HLG)이나 10비트 원본이 있으면 결과가 달라지므로
 * 사용자가 동의해야 내보낸다 (조용한 HDR→SDR, 10→8비트 변환 금지). 동의하면 HDR 은 톤 매핑한다.
 */

export const HDR_TRANSFERS = ['smpte2084', 'arib-std-b67'] as const;

export function isHdrTransfer(t: string | null | undefined): boolean {
  return t !== null && t !== undefined && (HDR_TRANSFERS as readonly string[]).includes(t);
}

/** HDR → SDR 8비트 BT.709 톤 매핑 (zimg 의 zscale 과 tonemap 필터가 필요하다) */
export const TONEMAP_FILTERS: readonly string[] = [
  'zscale=t=linear:npl=100',
  'format=gbrpf32le',
  'zscale=p=bt709',
  'tonemap=tonemap=hable:desat=0',
  'zscale=t=bt709:m=bt709:r=tv',
  'format=yuv420p',
];

export interface SourceColor {
  fileName: string;
  hdr: boolean;
  bitDepth: number | null;
}

/** SDR 8비트로 바뀌는 원본 목록 (사람이 읽는 문장). 바뀌는 것이 없으면 빈 배열 */
export function conversionWarnings(sources: readonly SourceColor[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    if (s.hdr) out.push(`${s.fileName}: HDR → SDR (톤 매핑, 색과 밝기가 달라집니다)`);
    else if (s.bitDepth !== null && s.bitDepth > 8) {
      out.push(`${s.fileName}: ${String(s.bitDepth)}비트 → 8비트`);
    }
  }
  return out;
}

/** 필터 목록 출력에서 톤 매핑에 필요한 필터가 모두 있는지 */
export function supportsTonemap(filtersOutput: string): boolean {
  return /\bzscale\b/.test(filtersOutput) && /\btonemap\b/.test(filtersOutput);
}
