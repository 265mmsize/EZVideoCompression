/** 원본 다시 연결: 같은 경로 참조를 모두 바꾸고, 짧은 새 파일은 끝 시점을 줄이며, 없는 참조를 찾는다 */
import { describe, expect, it } from 'vitest';
import { missingRefs, replaceSourcePath, type RelinkInfo } from '../../src/shared/relink';
import { newProject } from '../../src/main/services/edit/VideoEditService';
import type { EditClip, EditProject, EditTrack } from '../../src/shared/types/domain';

function clip(over: Partial<EditClip> = {}): EditClip {
  return {
    id: 'c1',
    path: '/old/a.mp4',
    fileName: 'a.mp4',
    sourceDurationSec: 10,
    sourceWidth: 1280,
    sourceHeight: 720,
    hasAudio: true,
    inSec: 1,
    outSec: 8,
    speed: 1,
    volume: 1,
    mute: false,
    rotate: 0,
    flipH: false,
    flipV: false,
    filters: { brightness: 0, contrast: 1, saturation: 1, sharpen: 0, denoise: 0 },
    stabilize: false,
    transition: { type: 'none', durationSec: 1 },
    texts: [],
    ...over,
  };
}

const info = (over: Partial<RelinkInfo> = {}): RelinkInfo => ({
  path: '/new/a.mp4',
  fileName: 'a.mp4',
  durationSec: 10,
  width: 1920,
  height: 1080,
  hasAudio: true,
  audioChannels: 2,
  hdr: false,
  bitDepth: 8,
  ...over,
});

function project(over: Partial<EditProject> = {}): EditProject {
  return { ...newProject('다시 연결', '2026-11-05T00:00:00.000Z'), ...over };
}

describe('원본 다시 연결', () => {
  it('같은 경로의 클립을 모두 바꾸고 구간은 그대로 둔다', () => {
    const p = project({
      clips: [clip(), clip({ id: 'c2' }), clip({ id: 'c3', path: '/other.mp4' })],
    });
    const r = replaceSourcePath(p, '/old/a.mp4', info());
    expect(r.project.clips.map((c) => c.path)).toEqual(['/new/a.mp4', '/new/a.mp4', '/other.mp4']);
    expect(r.project.clips[0]).toMatchObject({
      inSec: 1,
      outSec: 8,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(r.warnings).toEqual([]);
  });

  it('트랙 클립, 배경 음악, 워터마크도 함께 바꾼다', () => {
    const track: EditTrack = {
      id: 't',
      kind: 'video',
      name: '영상 1',
      enabled: true,
      clips: [
        {
          ...clip({ id: 'tc' }),
          kind: 'video',
          startSec: 0,
          x: 0.5,
          y: 0.5,
          scale: 0.4,
          opacity: 1,
          anim: { x: [], y: [], scale: [], opacity: [], volume: [] },
        },
      ],
    };
    const p = project({
      clips: [clip()],
      tracks: [track],
      music: {
        path: '/old/a.mp4',
        fileName: 'a.mp4',
        sourceDurationSec: 10,
        volume: 1,
        fadeInSec: 0,
        fadeOutSec: 0,
        loop: false,
        originalMix: 1,
      },
      watermark: {
        path: '/old/a.mp4',
        fileName: 'a.mp4',
        position: 'center',
        scale: 0.2,
        opacity: 1,
      },
    });
    const r = replaceSourcePath(p, '/old/a.mp4', info());
    expect(r.project.tracks[0]?.clips[0]?.path).toBe('/new/a.mp4');
    expect(r.project.music?.path).toBe('/new/a.mp4');
    expect(r.project.watermark?.path).toBe('/new/a.mp4');
  });

  it('새 파일이 짧으면 끝 시점을 줄이고 알린다', () => {
    const r = replaceSourcePath(
      project({ clips: [clip({ outSec: 8 })] }),
      '/old/a.mp4',
      info({ durationSec: 5 }),
    );
    expect(r.project.clips[0]?.outSec).toBe(5);
    expect(r.warnings[0]).toContain('짧아 끝 시점');
  });

  it('쓸 구간이 남지 않으면 경고한다', () => {
    const r = replaceSourcePath(
      project({ clips: [clip({ inSec: 4.95, outSec: 5 })] }),
      '/old/a.mp4',
      info({ durationSec: 4.97 }),
    );
    expect(r.warnings.join('\n')).toContain('쓸 구간이 남지 않았습니다');
  });

  it('없는 원본 참조를 역할별로 찾는다', () => {
    const p = project({
      clips: [
        clip({ path: '/gone.mp4', fileName: 'gone.mp4' }),
        clip({ id: 'c2', path: '/here.mp4' }),
      ],
      watermark: {
        path: '/gone.png',
        fileName: 'gone.png',
        position: 'center',
        scale: 0.2,
        opacity: 1,
      },
    });
    const missing = missingRefs(p, (x) => x !== '/gone.mp4' && x !== '/gone.png');
    expect(missing).toEqual([
      { role: 'clip', path: '/gone.mp4', fileName: 'gone.mp4' },
      { role: 'watermark', path: '/gone.png', fileName: 'gone.png' },
    ]);
  });
});
