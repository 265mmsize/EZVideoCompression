/**
 * 미리보기와 내보내기의 기하(위치·크기) 일치 검증.
 * 4:3 영상을 16:9 캔버스에 맞추면 가로 75%만 채운다. 실제 렌더 결과의 가로 비율을 픽셀로 재서
 * 미리보기 계산(contentBox)과 맞는지 확인한다. 색과 세부 모양은 검사하지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';
import { contentBox } from '../../src/renderer/pages/previewMath';
import type { EditClip, EditRenderProgress } from '../../src/shared/types/domain';

let ws: Workspace;
let dir: string;
const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg';

async function waitRender(renderId: string): Promise<EditRenderProgress> {
  const deadline = Date.now() + 240_000;
  for (;;) {
    const last = ws.events
      .filter((e) => e.channel === 'edit:render.progress')
      .map((e) => e.payload as EditRenderProgress)
      .filter((p) => p.renderId === renderId)
      .pop();
    if (last && last.status !== 'running') return last;
    if (Date.now() > deadline) throw new Error('렌더 시간 초과');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  ws = createWorkspace('vslim-geom-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  dir = path.join(ws.root, '기하 자료');
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x240:r=30:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path.join(dir, '사분할.mp4'),
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);
}, 120_000);

afterAll(async () => {
  await ws.cleanup();
});

/** 가운데 가로줄의 밝은 픽셀 범위 (가로 비율). 프레임 전체를 읽고 가운데 줄을 고른다. */
function contentWidthRatio(file: string, canvasW: number, canvasH: number): number {
  const r = spawnSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-ss',
      '0.5',
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const frame = r.stdout;
  const rowStart = Math.floor(canvasH / 2) * canvasW * 3;
  let first = -1;
  let last = -1;
  for (let x = 0; x < canvasW; x++) {
    const i = rowStart + x * 3;
    const lum = (frame[i] ?? 0) * 0.3 + (frame[i + 1] ?? 0) * 0.59 + (frame[i + 2] ?? 0) * 0.11;
    if (lum > 24) {
      if (first < 0) first = x;
      last = x;
    }
  }
  return first < 0 ? 0 : (last - first + 1) / canvasW;
}

describe('미리보기와 내보내기의 위치·크기', () => {
  it('4:3 영상을 16:9 캔버스에 맞춘 가로 비율이 미리보기 계산과 1% 안에서 같다', async () => {
    const info = await ws.services.videoEdit.probeSource(path.join(dir, '사분할.mp4'));
    const clip: EditClip = {
      id: crypto.randomUUID(),
      path: info.path,
      fileName: info.fileName,
      sourceDurationSec: info.durationSec ?? 1,
      sourceWidth: info.width ?? 320,
      sourceHeight: info.height ?? 240,
      hasAudio: false,
      inSec: 0,
      outSec: info.durationSec ?? 1,
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
    };
    const p0 = ws.services.videoEdit.create('기하');
    const project = {
      ...p0,
      clips: [clip],
      canvas: { preset: '720p' as const, fps: 30 as const },
      output: {
        container: 'mp4' as const,
        codec: 'h264' as const,
        crf: 20,
        preset: 'veryfast' as const,
      },
    };
    ws.services.videoEdit.save(project);
    const done = await waitRender(
      ws.services.videoEdit.render(project.id, 'export', { kind: 'suffix', suffix: '-geom' }),
    );
    expect(done.status, done.error ?? '').toBe('done');

    const canvas = { width: 1280, height: 720 };
    const rendered = contentWidthRatio(done.outputPath ?? '', canvas.width, canvas.height);
    const preview = contentBox(clip, canvas).widthPct / 100;
    expect(preview).toBeCloseTo(0.75, 3);
    // 판독이 실패하면 값이 0 이므로 먼저 확인한다
    expect(rendered, `file=${done.outputPath ?? ''}`).toBeGreaterThan(0.5);
    expect(Math.abs(rendered - preview)).toBeLessThan(0.01);
  }, 300_000);
});
