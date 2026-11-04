/**
 * 클립 페이드와 프레임 고정을 실제 FFmpeg 로 확인한다:
 * 시작 페이드 직후는 어둡고, 중간은 밝아진다. 프레임 고정 구간은 원본 한 프레임을 멈춰 보여 주고
 * 소리가 없으며, 전체 길이는 앞 + 고정 길이 + 뒤와 같다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';
import { freezeAt } from '../../src/renderer/pages/clipEdits';
import type { EditClip, EditRenderProgress } from '../../src/shared/types/domain';

let ws: Workspace;
let dir: string;
const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
const FFPROBE = process.env['FFPROBE_PATH'] ?? 'ffprobe';

function ff(args: string[]): void {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

/** 원본 영상의 t 초 한 점 (RGB) */
function pixelAt(file: string, t: number): [number, number, number] {
  const png = path.join(dir, `px-${t.toFixed(3)}.png`);
  ff(['-ss', String(t), '-i', file, '-frames:v', '1', png]);
  const r = spawnSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-i',
      png,
      '-vf',
      'crop=1:1:160:120',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer' },
  );
  return [r.stdout[0] ?? 0, r.stdout[1] ?? 0, r.stdout[2] ?? 0];
}

function meanVolume(file: string, from: number, len: number): number {
  const r = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-ss',
      String(from),
      '-t',
      String(len),
      '-i',
      file,
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  if (!m?.[1]) throw new Error(`음량을 읽지 못했습니다: ${r.stderr.slice(-200)}`);
  return Number(m[1]);
}

function durationOf(file: string): number {
  const r = spawnSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    {
      encoding: 'utf8',
    },
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
  ws = createWorkspace('vslim-finish-clip-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  dir = path.join(ws.root, '클립 마무리');
  fs.mkdirSync(dir, { recursive: true });
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=white:s=320x240:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    path.join(dir, '흰색.mp4'),
  ]);
}, 120_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('클립 페이드와 프레임 고정 렌더', () => {
  it('시작 페이드는 검정에서 시작하고, 프레임 고정 구간은 소리 없이 한 장면을 멈추며, 길이는 세 조각 합', async () => {
    const info = await ws.services.videoEdit.probeSource(path.join(dir, '흰색.mp4'));
    const base: EditClip = {
      id: crypto.randomUUID(),
      path: info.path,
      fileName: info.fileName,
      sourceDurationSec: info.durationSec ?? 2,
      sourceWidth: info.width ?? 320,
      sourceHeight: info.height ?? 240,
      hasAudio: true,
      hdr: false,
      bitDepth: 8,
      inSec: 0,
      outSec: 2,
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
      fadeInSec: 1,
      fadeOutSec: 0.5,
    };
    // 1초 지점에서 1.5초짜리 고정 프레임을 넣는다 → 결과 1 + 1.5 + 1 = 3.5초
    const pieces = freezeAt(base, 1, () => crypto.randomUUID(), 1.5);
    expect(pieces).not.toBeNull();
    const p0 = ws.services.videoEdit.create('클립 마무리');
    const project = {
      ...p0,
      clips: pieces as EditClip[],
      canvas: { preset: '720p' as const, fps: 30 as const },
      output: {
        container: 'mp4' as const,
        codec: 'h264' as const,
        crf: 24,
        preset: 'veryfast' as const,
      },
    };
    ws.services.videoEdit.save(project);
    const done = await waitRender(
      ws.services.videoEdit.render(project.id, 'export', { kind: 'suffix', suffix: '-finish' }),
    );
    expect(done.status, done.error ?? '').toBe('done');
    const out = done.outputPath ?? '';
    expect(Math.abs(durationOf(out) - 3.5)).toBeLessThan(0.15);

    // 시작 0초: 페이드 인 시작이라 어둡다 (흰색 → 검정)
    const [r0] = pixelAt(out, 0.02);
    expect(r0).toBeLessThan(40);
    // 0.5초: 페이드 중간쯤이라 밝다
    const [r05] = pixelAt(out, 0.5);
    expect(r05).toBeGreaterThan(80);
    expect(r05).toBeLessThan(220);
    // 1.2초와 2.3초: 고정 프레임 구간 안, 같은 장면이 멈춰 있다 (흰색 유지)
    const [a] = pixelAt(out, 1.2);
    const [b] = pixelAt(out, 2.3);
    expect(a).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
    // 고정 프레임 구간 소리는 무음 (표준 음량 -91dB 근처)
    expect(meanVolume(out, 1.2, 1)).toBeLessThan(-60);
    // 앞 조각 소리는 있다
    expect(meanVolume(out, 0.4, 0.4)).toBeGreaterThan(-60);
  }, 300_000);
});
