/**
 * 추가 트랙과 키프레임을 실제 FFmpeg 로 렌더한다:
 * 파란 바탕 영상 위에 빨간 이미지를 1초부터 겹치되 투명도를 0→1 로 올리고, 오디오 트랙을 섞는다.
 * 이전 버전 프로젝트(트랙 없음)도 불러온다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';
import { kcpFileSchema } from '../../src/shared/schemas/ipc.schemas';
import type {
  EditClip,
  EditProject,
  EditRenderProgress,
  EditTrackClip,
} from '../../src/shared/types/domain';

let ws: Workspace;
let dir: string;

function ff(args: string[]): void {
  const r = spawnSync(process.env['FFMPEG_PATH'] ?? 'ffmpeg', ['-v', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
}

function pixelAt(file: string, t: number, x: number, y: number): [number, number, number] {
  const png = path.join(dir, `px-${String(t)}.png`);
  ff(['-ss', String(t), '-i', file, '-frames:v', '1', png]);
  const r = spawnSync(
    process.env['FFMPEG_PATH'] ?? 'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      png,
      '-vf',
      `crop=1:1:${String(x)}:${String(y)}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer' },
  );
  const b = r.stdout;
  return [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0];
}

function streams(file: string): { kinds: string[]; duration: number } {
  const r = spawnSync(
    process.env['FFPROBE_PATH'] ?? 'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  const j = JSON.parse(r.stdout) as {
    streams: { codec_type: string }[];
    format: { duration: string };
  };
  return { kinds: j.streams.map((s) => s.codec_type).sort(), duration: Number(j.format.duration) };
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
  ws = createWorkspace('vslim-tracks-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  dir = path.join(ws.root, '트랙 자료');
  fs.mkdirSync(dir, { recursive: true });
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=640x360:r=30:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    path.join(dir, '바탕.mp4'),
  ]);
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=200x100', '-frames:v', '1', path.join(dir, '로고.png')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', path.join(dir, '효과음.wav')]);
}, 120_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('추가 트랙 렌더', () => {
  it('이미지 오버레이는 시작 전에는 없고, 투명도 키프레임 뒤에는 보이며, 오디오 트랙이 섞인다', async () => {
    const base = await ws.services.videoEdit.probeSource(path.join(dir, '바탕.mp4'));
    const main: EditClip = {
      id: crypto.randomUUID(),
      path: base.path,
      fileName: base.fileName,
      sourceDurationSec: base.durationSec ?? 3,
      sourceWidth: base.width ?? 640,
      sourceHeight: base.height ?? 360,
      hasAudio: base.hasAudio,
      inSec: 0,
      outSec: 3,
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
    const logo: EditTrackClip = {
      id: crypto.randomUUID(),
      path: path.join(dir, '로고.png'),
      fileName: '로고.png',
      kind: 'image',
      sourceDurationSec: 86_400,
      sourceWidth: 200,
      sourceHeight: 100,
      hasAudio: false,
      startSec: 1,
      inSec: 0,
      outSec: 2,
      volume: 1,
      mute: false,
      x: 0.5,
      y: 0.5,
      scale: 0.25,
      opacity: 1,
      anim: {
        x: [],
        y: [],
        scale: [],
        opacity: [
          { t: 0, v: 0 },
          { t: 0.5, v: 1 },
        ],
        volume: [],
      },
    };
    const sfx: EditTrackClip = {
      ...logo,
      id: crypto.randomUUID(),
      path: path.join(dir, '효과음.wav'),
      fileName: '효과음.wav',
      kind: 'audio',
      sourceDurationSec: 2,
      sourceWidth: 0,
      sourceHeight: 0,
      hasAudio: true,
      startSec: 0.5,
      inSec: 0,
      outSec: 2,
      anim: { x: [], y: [], scale: [], opacity: [], volume: [] },
    };
    const p0 = ws.services.videoEdit.create('트랙 렌더');
    const project: EditProject = {
      ...p0,
      clips: [main],
      canvas: { preset: '720p', fps: 30 },
      output: { container: 'mp4', codec: 'h264', crf: 26, preset: 'veryfast' },
      tracks: [
        { id: crypto.randomUUID(), kind: 'video', name: '영상 1', enabled: true, clips: [logo] },
        { id: crypto.randomUUID(), kind: 'audio', name: '오디오 1', enabled: true, clips: [sfx] },
      ],
    };
    ws.services.videoEdit.save(project);
    const renderId = ws.services.videoEdit.render(project.id, 'export', {
      kind: 'suffix',
      suffix: '-tracks',
    });
    const done = await waitRender(renderId);
    expect(done.status, done.error ?? '').toBe('done');
    const out = done.outputPath ?? '';
    const info = streams(out);
    expect(info.kinds).toEqual(['audio', 'video']);
    expect(Math.abs(info.duration - 3)).toBeLessThan(0.2);
    // 1280x720 캔버스 가운데: 시작 전(0.5초)은 파랑, 투명도 0 인 시작 순간도 파랑, 2.5초는 빨강
    const isBlue = ([r, g, b]: [number, number, number]): boolean => b > 180 && r < 60 && g < 60;
    const isRed = ([r, g, b]: [number, number, number]): boolean => r > 180 && g < 60 && b < 60;
    expect(isBlue(pixelAt(out, 0.5, 640, 360))).toBe(true);
    expect(isBlue(pixelAt(out, 1.0, 640, 360))).toBe(true);
    expect(isRed(pixelAt(out, 2.5, 640, 360))).toBe(true);
    // 오버레이 바깥은 계속 파랑 (크기 0.25 → 320×160)
    expect(isBlue(pixelAt(out, 2.5, 100, 100))).toBe(true);
  }, 300_000);
});

describe('이전 버전 프로젝트', () => {
  it('트랙 필드가 없어도 빈 트랙으로 불러오고, .kcp 형식 검사도 빈 트랙으로 채운다', () => {
    const p = ws.services.videoEdit.create('옛 프로젝트');
    const legacy = { ...p } as Partial<EditProject>;
    delete legacy.tracks;
    ws.services.db
      .prepare('UPDATE edit_projects SET json = ? WHERE id = ?')
      .run(JSON.stringify(legacy), p.id);
    expect(ws.services.videoEdit.get(p.id).tracks).toEqual([]);
    expect(ws.services.videoEdit.list().some((s) => s.id === p.id)).toBe(true);
    const parsed = kcpFileSchema.safeParse({ format: 'kcp', version: 1, project: legacy });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.project.tracks).toEqual([]);
  });
});

describe('움직임·트랙 모양 렌더', () => {
  it('확대·초점 키프레임으로 가운데가 왼쪽 위(빨강)에서 오른쪽 아래(노랑)로 바뀌고, 회전 오버레이와 배속 소리가 들어간다', async () => {
    const quad = path.join(dir, '사분면.mp4');
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x180:r=30:d=3',
      '-f',
      'lavfi',
      '-i',
      'color=c=lime:s=320x180:r=30:d=3',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x180:r=30:d=3',
      '-f',
      'lavfi',
      '-i',
      'color=c=yellow:s=320x180:r=30:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=3',
      '-filter_complex',
      '[0:v][1:v]hstack[t];[2:v][3:v]hstack[b];[t][b]vstack[v]',
      '-map',
      '[v]',
      '-map',
      '4:a',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      quad,
    ]);
    const info = await ws.services.videoEdit.probeSource(quad);
    const main: EditClip = {
      id: crypto.randomUUID(),
      path: info.path,
      fileName: info.fileName,
      sourceDurationSec: info.durationSec ?? 3,
      sourceWidth: info.width ?? 640,
      sourceHeight: info.height ?? 360,
      hasAudio: info.hasAudio,
      inSec: 0,
      outSec: 3,
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
      motion: {
        zoom: [{ t: 0, v: 2 }],
        panX: [
          { t: 0, v: 0 },
          { t: 2, v: 1 },
        ],
        panY: [
          { t: 0, v: 0 },
          { t: 2, v: 1 },
        ],
        volume: [
          { t: 0, v: 0 },
          { t: 1, v: 1 },
        ],
      },
    };
    const logo: EditTrackClip = {
      id: crypto.randomUUID(),
      path: path.join(dir, '로고.png'),
      fileName: '로고.png',
      kind: 'image',
      sourceDurationSec: 86_400,
      sourceWidth: 200,
      sourceHeight: 100,
      hasAudio: false,
      startSec: 2,
      inSec: 0,
      outSec: 1,
      volume: 1,
      mute: false,
      x: 0.5,
      y: 0.5,
      scale: 0.1,
      opacity: 1,
      anim: { x: [], y: [], scale: [], opacity: [], volume: [] },
      rotate: 90,
    };
    const sfx: EditTrackClip = {
      ...logo,
      id: crypto.randomUUID(),
      path: path.join(dir, '효과음.wav'),
      fileName: '효과음.wav',
      kind: 'audio',
      sourceDurationSec: 2,
      sourceWidth: 0,
      sourceHeight: 0,
      hasAudio: true,
      startSec: 0,
      inSec: 0,
      outSec: 2,
      rotate: undefined,
      speed: 2,
    };
    const p0 = ws.services.videoEdit.create('움직임 렌더');
    const project: EditProject = {
      ...p0,
      clips: [main],
      canvas: { preset: '720p', fps: 30 },
      output: { container: 'mp4', codec: 'h264', crf: 26, preset: 'veryfast' },
      tracks: [
        { id: crypto.randomUUID(), kind: 'video', name: '영상 1', enabled: true, clips: [logo] },
        { id: crypto.randomUUID(), kind: 'audio', name: '오디오 1', enabled: true, clips: [sfx] },
      ],
    };
    ws.services.videoEdit.save(project);
    const renderId = ws.services.videoEdit.render(project.id, 'export', {
      kind: 'suffix',
      suffix: '-motion',
    });
    const done = await waitRender(renderId);
    expect(done.status, done.error ?? '').toBe('done');
    const out = done.outputPath ?? '';
    const s = streams(out);
    expect(s.kinds).toEqual(['audio', 'video']);
    expect(Math.abs(s.duration - 3)).toBeLessThan(0.2);
    const isRed = ([r, g, b]: [number, number, number]): boolean => r > 180 && g < 80 && b < 80;
    const isYellow = ([r, g, b]: [number, number, number]): boolean => r > 180 && g > 180 && b < 80;
    // 0.2초: 확대 2배, 초점 왼쪽 위 → 화면 가운데에 빨강 사분면
    expect(isRed(pixelAt(out, 0.2, 640, 360))).toBe(true);
    // 2.5초: 초점 오른쪽 아래 → 화면 가운데에 노랑 사분면, 오버레이는 90도 회전해 세로로 길다
    expect(isYellow(pixelAt(out, 2.5, 200, 600))).toBe(true);
    // 로고 200×100 을 90도 돌리면 100×200, 너비를 캔버스의 0.1(128px)로 맞추면 128×256 이 된다.
    // 회전하지 않았다면 128×64 로 가운데 ±32px 에만 있을 빨강이 위로 100px 지점에도 있다.
    expect(isRed(pixelAt(out, 2.5, 640, 360 - 100))).toBe(true);
    // 너비 ±64px 바깥은 바탕(노랑)이다
    expect(isYellow(pixelAt(out, 2.5, 640 - 80, 360))).toBe(true);
  }, 300_000);
});
