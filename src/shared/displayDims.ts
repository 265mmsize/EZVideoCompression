/**
 * 표시 크기 (순수 함수). 휴대폰 영상은 저장된 가로·세로와 화면에 보이는 방향이 다르다.
 * 회전 정보가 90 또는 270 이면 가로와 세로를 바꾼 크기가 화면에 보이는 크기다.
 * FFmpeg 는 디코딩할 때 이 회전을 자동으로 적용한다.
 */
export function displaySize(
  width: number | null,
  height: number | null,
  rotation: number | null | undefined,
): { width: number | null; height: number | null } {
  if (width === null || height === null) return { width, height };
  const r = (((rotation ?? 0) % 360) + 360) % 360;
  const swap = r === 90 || r === 270;
  return swap ? { width: height, height: width } : { width, height };
}
