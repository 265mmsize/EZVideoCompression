/**
 * 영상 편집 캔버스 결정 규칙 (순수 함수). 렌더 계획(메인)과 실시간 미리보기(렌더러)가 같은 규칙을 쓴다.
 */
import type { CanvasPreset, EditProject } from './types/domain';

export interface Canvas {
  width: number;
  height: number;
  fps: number;
}

export const CANVAS_SIZES: Readonly<Record<Exclude<CanvasPreset, 'auto'>, [number, number]>> = {
  '1080p': [1920, 1080],
  '720p': [1280, 720],
  '4k': [3840, 2160],
  vertical1080: [1080, 1920],
  square1080: [1080, 1080],
};

/** 인코더가 요구하는 짝수 크기 (최소 2) */
export function evenSize(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r + 1;
}

/** 캔버스 결정. auto 는 첫 클립의 (회전 반영) 원본 크기, fps auto 는 30 */
export function resolveCanvas(project: Pick<EditProject, 'canvas' | 'clips'>): Canvas {
  const fps = project.canvas.fps === 'auto' ? 30 : project.canvas.fps;
  if (project.canvas.preset !== 'auto') {
    const [w, h] = CANVAS_SIZES[project.canvas.preset];
    return { width: w, height: h, fps };
  }
  const first = project.clips[0];
  if (!first) return { width: 1280, height: 720, fps };
  const swap = first.rotate === 90 || first.rotate === 270;
  const w = swap ? first.sourceHeight : first.sourceWidth;
  const h = swap ? first.sourceWidth : first.sourceHeight;
  return { width: evenSize(w), height: evenSize(h), fps };
}
