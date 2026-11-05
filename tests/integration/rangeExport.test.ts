/**
 * 선택 구간만 내보내기: 결과 길이는 구간 길이와 같고, 저장된 프로젝트는 한 글자도 바뀌지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';
import type { EditClip, EditRenderProgress } from '../../src/shared/types/domain';

let ws: Workspace;
let video: string;

function durationOf(file: string): number {
  const r = spawnSync(
    process.env['FFPROBE_PATH'] ?? 'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return Number(r.stdout.trim());
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
  ws = createWorkspace('vslim-range-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  const dir = path.join(ws.root, '구간 자료');
  fs.mkdirSync(dir, { recursive: true });
  video = path.join(dir, '구간.mp4');
  fs.copyFileSync(ws.fixtures['h264_sdr.mp4'], video);
}, 120_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('선택 구간만 내보내기', () => {
  it('1~2초 구간을 내보내면 길이가 1초이고, 저장된 프로젝트는 그대로다', async () => {
    const info = await ws.services.videoEdit.probeSource(video);
    const clip: EditClip = {
      id: crypto.randomUUID(),
      path: info.path,
      fileName: info.fileName,
      sourceDurationSec: info.durationSec ?? 3,
      sourceWidth: info.width ?? 320,
      sourceHeight: info.height ?? 240,
      hasAudio: info.hasAudio,
      audioChannels: info.audioChannels,
      inSec: 0,
      outSec: info.durationSec ?? 3,
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
    const p0 = ws.services.videoEdit.create('구간 내보내기');
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
    const before = JSON.stringify(ws.services.videoEdit.get(project.id));

    const done = await waitRender(
      ws.services.videoEdit.render(
        project.id,
        'export',
        { kind: 'suffix', suffix: '-range' },
        {
          startSec: 1,
          endSec: 2,
        },
      ),
    );
    expect(done.status, done.error ?? '').toBe('done');
    expect(path.basename(done.outputPath ?? '')).toBe('구간 내보내기-range.mp4');
    expect(Math.abs(durationOf(done.outputPath ?? '') - 1)).toBeLessThan(0.15);

    // 저장된 프로젝트는 그대로 (구간 복사본만 렌더했다)
    expect(JSON.stringify(ws.services.videoEdit.get(project.id))).toBe(before);
  }, 300_000);
});
