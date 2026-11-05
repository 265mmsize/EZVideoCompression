/**
 * 인터레이스 영상을 실제로 감지하고, 인터레이스 제거를 켜고 렌더하면 결과가 더 이상 인터레이스가 아니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';
import type { EditClip, EditRenderProgress } from '../../src/shared/types/domain';

let ws: Workspace;
let dir: string;
const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
const FFPROBE = process.env['FFPROBE_PATH'] ?? 'ffprobe';

function fieldOrder(file: string): string {
  const r = spawnSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=field_order',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  );
  return r.stdout.trim();
}

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
  ws = createWorkspace('vslim-source-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  dir = path.join(ws.root, '원본 보정');
  fs.mkdirSync(dir, { recursive: true });
  // 위 필드가 먼저인 인터레이스 영상 (방송·카메라 원본과 같은 구조)
  const r = spawnSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x240:r=25:d=2',
      '-c:v',
      'libx264',
      '-flags',
      '+ildct+ilme',
      '-x264-params',
      'tff=1',
      path.join(dir, '인터레이스.mp4'),
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);
}, 120_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('인터레이스 원본', () => {
  it('등록할 때 인터레이스로 감지하고, 제거를 켠 렌더 결과는 인터레이스가 아니다', async () => {
    const file = path.join(dir, '인터레이스.mp4');
    expect(fieldOrder(file)).toMatch(/^(tt|bb|tb|bt)$/);
    const info = await ws.services.videoEdit.probeSource(file);
    expect(info.interlaced).toBe(true);

    const clip: EditClip = {
      id: crypto.randomUUID(),
      path: info.path,
      fileName: info.fileName,
      sourceDurationSec: info.durationSec ?? 2,
      sourceWidth: info.width ?? 320,
      sourceHeight: info.height ?? 240,
      hasAudio: info.hasAudio,
      audioChannels: info.audioChannels,
      deinterlace: true,
      inSec: 0,
      outSec: info.durationSec ?? 2,
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
    const p0 = ws.services.videoEdit.create('인터레이스 제거');
    const project = {
      ...p0,
      clips: [clip],
      canvas: { preset: '720p' as const, fps: 30 as const },
      output: {
        container: 'mp4' as const,
        codec: 'h264' as const,
        crf: 28,
        preset: 'veryfast' as const,
      },
    };
    ws.services.videoEdit.save(project);
    const done = await waitRender(
      ws.services.videoEdit.render(project.id, 'export', { kind: 'suffix', suffix: '-prog' }),
    );
    expect(done.status, done.error ?? '').toBe('done');
    expect(fieldOrder(done.outputPath ?? '')).not.toMatch(/^(tt|bb|tb|bt)$/);
  }, 300_000);
});
