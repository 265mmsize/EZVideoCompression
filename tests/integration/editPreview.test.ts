/** 영상 편집 실시간 미리보기용 재생 주소: 영상·음성만 열고, 토큰은 원래 파일과 형식으로 해석된다 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';

let ws: Workspace;

function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

beforeAll(async () => {
  ws = createWorkspace('vslim-preview-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
}, 120_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('미리보기 재생 주소', () => {
  it('영상 파일은 vslim-media 주소로 열리고 원래 경로와 video/mp4 로 해석된다', () => {
    const video = path.join(ws.inputDir, '미리보기 영상.mp4');
    fs.copyFileSync(ws.fixtures['h264_sdr.mp4'], video);
    const { url } = ws.services.videoEdit.mediaUrl(video);
    expect(url.startsWith('vslim-media://file/')).toBe(true);
    expect(ws.services.tokens.resolve(tokenOf(url))).toEqual({ path: video, mime: 'video/mp4' });
    // 같은 파일은 같은 주소 (렌더러가 캐시해도 된다)
    expect(ws.services.videoEdit.mediaUrl(video).url).toBe(url);
  });

  it('배경 음악 파일은 audio 형식으로 열린다', () => {
    const song = path.join(ws.inputDir, '음악.mp3');
    const r = spawnSync(
      process.env['FFMPEG_PATH'] ?? 'ffmpeg',
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', song],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    const { url } = ws.services.videoEdit.mediaUrl(song);
    expect(ws.services.tokens.resolve(tokenOf(url))?.mime).toBe('audio/mpeg');
  });

  it('영상·음성이 아닌 파일, 없는 파일, 폴더는 거부한다', () => {
    const text = path.join(ws.inputDir, '메모.txt');
    fs.writeFileSync(text, '글');
    expect(() => ws.services.videoEdit.mediaUrl(text)).toThrow();
    expect(() => ws.services.videoEdit.mediaUrl(path.join(ws.inputDir, '없음.mp4'))).toThrow();
    expect(() => ws.services.videoEdit.mediaUrl(ws.inputDir)).toThrow();
  });
});

describe('오디오 파형', () => {
  it('음성이 있는 3초 영상은 초당 50개 피크를 내고 소리가 있는 칸이 있다', async () => {
    const video = path.join(ws.inputDir, '파형 영상.mp4');
    fs.copyFileSync(ws.fixtures['h264_sdr.mp4'], video);
    const w = await ws.services.videoEdit.waveform(video);
    expect(w.peaksPerSec).toBe(50);
    expect(w.peaks.length).toBeGreaterThanOrEqual(140);
    expect(w.peaks.length).toBeLessThanOrEqual(160);
    expect(Math.max(...w.peaks)).toBeGreaterThan(0);
    expect(w.peaks.every((v) => Number.isInteger(v) && v >= 0 && v <= 100)).toBe(true);
    // 두 번째 요청은 캐시에서 같은 결과
    expect(await ws.services.videoEdit.waveform(video)).toBe(w);
  });

  it('음성이 없는 영상은 빈 파형', async () => {
    const silent = path.join(ws.inputDir, '무음.mp4');
    const r = spawnSync(
      process.env['FFMPEG_PATH'] ?? 'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x120:rate=10',
        '-t',
        '1',
        silent,
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect((await ws.services.videoEdit.waveform(silent)).peaks).toEqual([]);
  });
});
