/**
 * 원본 파일 다시 연결 (순수 함수). 같은 경로를 쓰는 클립·트랙 클립·배경음악·워터마크를 모두 새 파일로 바꾼다.
 * 원본 구간은 유지하고, 새 파일이 짧으면 끝 시점을 줄이며 알린다.
 */
import type { EditProject } from './types/domain';

export interface RelinkInfo {
  path: string;
  fileName: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  audioChannels: number | null;
  hdr: boolean;
  bitDepth: number | null;
}

export interface RelinkResult {
  project: EditProject;
  warnings: string[];
}

/** 프로젝트에서 찾을 수 없는 원본 하나 (역할별로 나눈다) */
export interface MissingRef {
  role: 'clip' | 'track' | 'music' | 'watermark';
  path: string;
  fileName: string;
}

export function replaceSourcePath(p: EditProject, oldPath: string, info: RelinkInfo): RelinkResult {
  const warnings: string[] = [];
  const dur = info.durationSec ?? null;
  const clips = p.clips.map((c) => {
    if (c.path !== oldPath) return c;
    const sourceDurationSec = dur ?? c.sourceDurationSec;
    let outSec = c.outSec;
    if (outSec > sourceDurationSec + 0.05) {
      outSec = sourceDurationSec;
      warnings.push(
        `${info.fileName}: 새 파일이 짧아 끝 시점을 ${outSec.toFixed(2)}초로 줄였습니다`,
      );
    }
    if (outSec - c.inSec < 0.1)
      warnings.push(`${info.fileName}: 새 파일에서 쓸 구간이 남지 않았습니다`);
    return {
      ...c,
      path: info.path,
      fileName: info.fileName,
      sourceDurationSec,
      sourceWidth: info.width ?? c.sourceWidth,
      sourceHeight: info.height ?? c.sourceHeight,
      hasAudio: info.hasAudio,
      audioChannels: info.audioChannels,
      hdr: info.hdr,
      bitDepth: info.bitDepth,
      outSec,
    };
  });
  const tracks = p.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => {
      if (c.path !== oldPath) return c;
      const sourceDurationSec =
        c.kind === 'image' ? c.sourceDurationSec : (dur ?? c.sourceDurationSec);
      let outSec = c.outSec;
      if (c.kind !== 'image' && outSec > sourceDurationSec + 0.05) {
        outSec = sourceDurationSec;
        warnings.push(`${info.fileName}: 트랙 클립의 끝 시점을 새 파일 길이에 맞췄습니다`);
      }
      return {
        ...c,
        path: info.path,
        fileName: info.fileName,
        sourceDurationSec,
        sourceWidth: info.width ?? c.sourceWidth,
        sourceHeight: info.height ?? c.sourceHeight,
        hasAudio: info.hasAudio,
        outSec,
      };
    }),
  }));
  const music =
    p.music && p.music.path === oldPath
      ? {
          ...p.music,
          path: info.path,
          fileName: info.fileName,
          sourceDurationSec: dur ?? p.music.sourceDurationSec,
        }
      : p.music;
  const watermark =
    p.watermark && p.watermark.path === oldPath
      ? { ...p.watermark, path: info.path, fileName: info.fileName }
      : p.watermark;
  return { project: { ...p, clips, tracks, music, watermark }, warnings };
}

/** 프로젝트에서 디스크에 없는 원본 참조 목록 (같은 경로는 역할마다 한 번씩) */
export function missingRefs(p: EditProject, exists: (path: string) => boolean): MissingRef[] {
  const out: MissingRef[] = [];
  const seen = new Set<string>();
  const add = (role: MissingRef['role'], path: string, fileName: string): void => {
    const key = `${role}|${path}`;
    if (seen.has(key) || exists(path)) return;
    seen.add(key);
    out.push({ role, path, fileName });
  };
  for (const c of p.clips) add('clip', c.path, c.fileName);
  for (const t of p.tracks) for (const c of t.clips) add('track', c.path, c.fileName);
  if (p.music) add('music', p.music.path, p.music.fileName);
  if (p.watermark) add('watermark', p.watermark.path, p.watermark.fileName);
  return out;
}
