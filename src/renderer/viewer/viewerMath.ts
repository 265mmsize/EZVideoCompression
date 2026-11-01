/**
 * 킹뷰 보기 기능의 순수 계산: 쪽 배치(1장·2장), 웹툰 폭, 슬라이드쇼 순서, 루페 위치, 영역 좌표, 재생목록 편집.
 */
import { screenToImagePixel } from '../library/colorMath';

export type ViewMode = 'single' | 'spread' | 'webtoon';

/** 웹툰 모드 폭 (0 = 화면 전체 폭). 킹뷰 도움말 기준 100%, 640, 760, 800px */
export const WEBTOON_WIDTHS = [0, 640, 760, 800] as const;
export type WebtoonWidth = (typeof WEBTOON_WIDTHS)[number];

export const SLIDESHOW_INTERVALS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export interface SpreadOptions {
  /** 2장씩 보기 */
  twoUp: boolean;
  /** 표지(첫 장)는 혼자 보기 */
  coverSingle: boolean;
  /** 일본식 오른쪽에서 왼쪽으로 읽기 (펼친 쪽의 왼쪽이 뒤 장) */
  rtl: boolean;
}

/**
 * 장 번호 목록을 펼친 쪽 단위로 나눈다. 각 쪽은 화면에 보이는 순서(왼쪽, 오른쪽)로 적는다.
 * 1장씩 보기면 쪽마다 한 장이다.
 */
export function buildSpreads(count: number, opts: SpreadOptions): number[][] {
  if (count <= 0) return [];
  if (!opts.twoUp) return Array.from({ length: count }, (_, i) => [i]);
  const out: number[][] = [];
  let i = 0;
  if (opts.coverSingle) {
    out.push([0]);
    i = 1;
  }
  while (i < count) {
    const a = i;
    const b = i + 1;
    if (b < count) out.push(opts.rtl ? [b, a] : [a, b]);
    else out.push([a]);
    i += 2;
  }
  return out;
}

/** 장 번호가 들어 있는 쪽의 번호 (없으면 0) */
export function spreadIndexOf(spreads: readonly number[][], page: number): number {
  const idx = spreads.findIndex((s) => s.includes(page));
  return idx < 0 ? 0 : idx;
}

export function clampIndex(i: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, i));
}

/** 슬라이드쇼의 다음 장 (끝에서 처음으로 돈다) */
export function slideshowNext(i: number, count: number): number {
  if (count <= 0) return 0;
  return (i + 1) % count;
}

/** 목록에서 앞뒤로 움직인 장 번호 (범위를 넘지 않게) */
export function stepIndex(i: number, count: number, dir: 1 | -1): number {
  return clampIndex(i + dir, count);
}

/** 웹툰 폭 다음 단계 */
export function nextWebtoonWidth(w: WebtoonWidth): WebtoonWidth {
  const i = WEBTOON_WIDTHS.indexOf(w);
  return WEBTOON_WIDTHS[(i + 1) % WEBTOON_WIDTHS.length] ?? 0;
}

// ----- 루페 (누르고 있는 동안 돋보기) -----

export interface LoupeInput {
  cursorX: number;
  cursorY: number;
  boxW: number;
  boxH: number;
  natW: number;
  natH: number;
  zoom: number;
  radius: number;
}

/**
 * 돋보기 안에 그릴 배경의 크기와 위치. 이미지는 요소 안에 맞춤(contain)으로 놓인다고 가정한다.
 * 돋보기 중심(radius, radius)이 커서 아래의 이미지 점을 가리키도록 위치를 정한다.
 */
export function loupeBackground(
  p: LoupeInput,
): { bgW: number; bgH: number; posX: number; posY: number } | null {
  if (p.natW <= 0 || p.natH <= 0 || p.boxW <= 0 || p.boxH <= 0) return null;
  const fit = Math.min(p.boxW / p.natW, p.boxH / p.natH);
  const dispW = p.natW * fit;
  const dispH = p.natH * fit;
  const ox = (p.boxW - dispW) / 2;
  const oy = (p.boxH - dispH) / 2;
  const dx = p.cursorX - ox;
  const dy = p.cursorY - oy;
  return {
    bgW: dispW * p.zoom,
    bgH: dispH * p.zoom,
    posX: p.radius - dx * p.zoom,
    posY: p.radius - dy * p.zoom,
  };
}

/** 드래그로 고른 영역을 원본 픽셀 사각형으로 바꾼다. 이미지 밖이면 안쪽으로 맞춘다. 너무 작으면 null. */
export function regionFromDrag(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  view: { scale: number; tx: number; ty: number },
  boxW: number,
  boxH: number,
  natW: number,
  natH: number,
): { x: number; y: number; width: number; height: number } | null {
  const a = screenToImagePixel(view, boxW, boxH, natW, natH, Math.min(x0, x1), Math.min(y0, y1));
  const b = screenToImagePixel(view, boxW, boxH, natW, natH, Math.max(x0, x1), Math.max(y0, y1));
  const pa = a ?? clampToImage(view, boxW, boxH, natW, natH, Math.min(x0, x1), Math.min(y0, y1));
  const pb = b ?? clampToImage(view, boxW, boxH, natW, natH, Math.max(x0, x1), Math.max(y0, y1));
  if (!pa || !pb) return null;
  const x = Math.min(pa.x, pb.x);
  const y = Math.min(pa.y, pb.y);
  const width = Math.max(pa.x, pb.x) - x + 1;
  const height = Math.max(pa.y, pb.y) - y + 1;
  if (width < 2 || height < 2) return null;
  return { x, y, width: Math.min(width, natW - x), height: Math.min(height, natH - y) };
}

/** 이미지 바깥 좌표를 가장 가까운 이미지 가장자리 픽셀로 옮긴다 */
function clampToImage(
  view: { scale: number; tx: number; ty: number },
  boxW: number,
  boxH: number,
  natW: number,
  natH: number,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const fit = Math.min(boxW / natW, boxH / natH);
  const ox = (boxW - natW * fit) / 2;
  const oy = (boxH - natH * fit) / 2;
  const cx = (x - view.tx) / view.scale;
  const cy = (y - view.ty) / view.scale;
  const ix = Math.min(natW - 1, Math.max(0, Math.floor((cx - ox) / fit)));
  const iy = Math.min(natH - 1, Math.max(0, Math.floor((cy - oy) / fit)));
  return { x: ix, y: iy };
}

// ----- 재생목록 편집 (순수) -----

export interface PlaylistEntry {
  itemId: string;
}

export function addToPlaylist(list: readonly string[], itemId: string): string[] {
  return list.includes(itemId) ? [...list] : [...list, itemId];
}

export function removeFromPlaylist(list: readonly string[], index: number): string[] {
  return list.filter((_, i) => i !== index);
}

export function movePlaylistItem(list: readonly string[], index: number, dir: 1 | -1): string[] {
  const j = index + dir;
  if (index < 0 || j < 0 || index >= list.length || j >= list.length) return [...list];
  const next = [...list];
  const a = next[index] ?? '';
  next[index] = next[j] ?? '';
  next[j] = a;
  return next;
}
