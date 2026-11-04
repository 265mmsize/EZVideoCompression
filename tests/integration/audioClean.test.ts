/**
 * 소리 정리를 실제 FFmpeg 렌더로 확인한다:
 * 가운데(좌우 같은) 소리는 "보컬 줄이기"에서 사라지고, 왼쪽에만 있는 소리는 남는다.
 * "가운데 남기기"는 가운데 소리를 유지한다.
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

function ff(args: string[]): void {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

function meanVolume(file: string): number {
  const r = spawnSync(
    FFMPEG,
    ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  if (!m?.[1]) throw new Error(`음량을 읽지 못했습니다: ${r.stderr.slice(-200)}`);
  return Number(m[1]);
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

async function renderWith(file: string, extra: Partial<EditClip>, suffix: string): Promise<number> {
  const info = await ws.services.videoEdit.probeSource(file);
  const clip: EditClip = {
    id: crypto.randomUUID(),
    path: info.path,
    fileName: info.fileName,
    sourceDurationSec: info.durationSec ?? 2,
    sourceWidth: info.width ?? 320,
    sourceHeight: info.height ?? 240,
    hasAudio: true,
    audioChannels: info.audioChannels,
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
    ...extra,
  };
  const p0 = ws.services.videoEdit.create(`소리 ${suffix}`);
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
    ws.services.videoEdit.render(project.id, 'export', { kind: 'suffix', suffix: `-${suffix}` }),
  );
  expect(done.status, done.error ?? '').toBe('done');
  return meanVolume(done.outputPath ?? '');
}

beforeAll(async () => {
  ws = createWorkspace('vslim-clean-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  dir = path.join(ws.root, '소리 자료');
  fs.mkdirSync(dir, { recursive: true });
  // 가운데(좌우 같은) 440Hz 소리만 있는 스테레오 영상 (보컬처럼 가운데에 있는 소리)
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x240:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2,aformat=channel_layouts=stereo',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-shortest',
    path.join(dir, '가운데.mp4'),
  ]);
  // 왼쪽에만 있는 660Hz 소리 (악기처럼 한쪽에 있는 소리)
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x240:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:sample_rate=48000:duration=2,aformat=channel_layouts=stereo,pan=stereo|c0=c0|c1=0*c0',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-shortest',
    path.join(dir, '왼쪽.mp4'),
  ]);
  // 모노 영상
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x240:r=30:d=2',
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
    '-ac',
    '1',
    '-shortest',
    path.join(dir, '모노.mp4'),
  ]);
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('소리 정리 렌더', () => {
  it('보컬 줄이기는 가운데 소리를 지우고, 왼쪽에만 있는 소리는 남긴다', async () => {
    const center = path.join(dir, '가운데.mp4');
    const centerPlain = await renderWith(center, {}, 'c-plain');
    const centerReduced = await renderWith(center, { vocal: 'reduce' }, 'c-reduce');
    // 가운데 소리는 거의 사라진다 (-50dB 아래)
    expect(centerPlain).toBeGreaterThan(-30);
    expect(centerReduced).toBeLessThan(-50);

    const left = path.join(dir, '왼쪽.mp4');
    const leftPlain = await renderWith(left, {}, 'l-plain');
    const leftReduced = await renderWith(left, { vocal: 'reduce' }, 'l-reduce');
    // 한쪽 소리는 줄이기 후 양쪽에 같은 크기로 복사되어 약 3dB 커진다 (에너지 두 배 ÷ 채널 두 개)
    expect(Math.abs(leftReduced - leftPlain - 3)).toBeLessThan(1.5);
  }, 600_000);

  it('가운데 남기기는 가운데 소리를 살리고, 한쪽 소리는 약 3dB 작아진다', async () => {
    const center = path.join(dir, '가운데.mp4');
    const centerPlain = await renderWith(center, {}, 'c2-plain');
    const centerIsolated = await renderWith(center, { vocal: 'isolate' }, 'c2-isolate');
    expect(Math.abs(centerIsolated - centerPlain)).toBeLessThan(2);

    const left = path.join(dir, '왼쪽.mp4');
    const leftPlain = await renderWith(left, {}, 'l2-plain');
    const leftIsolated = await renderWith(left, { vocal: 'isolate' }, 'l2-isolate');
    // 왼쪽 소리는 좌우 평균이 되어 진폭이 절반, 전체 음량은 약 3dB 작아진다
    expect(Math.abs(leftPlain - leftIsolated - 3)).toBeLessThan(1.5);
  }, 600_000);

  it('모노 원본에서는 보컬 옵션이 적용되지 않는다 (결과가 그대로)', async () => {
    const file = path.join(dir, '모노.mp4');
    const plain = await renderWith(file, { audioChannels: 1 }, 'mono-plain');
    const forced = await renderWith(file, { audioChannels: 1, vocal: 'reduce' }, 'mono-forced');
    expect(Math.abs(forced - plain)).toBeLessThan(1);
  }, 600_000);
});
