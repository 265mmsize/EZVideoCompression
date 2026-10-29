/**
 * 영상 편집기를 실제 FFmpeg 로 확인한다: 프로젝트 저장, 소스 확인, 프레임, 미리보기 렌더, 내보내기(전환·속도·텍스트·음악·워터마크·손떨림 보정).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFixture, createWorkspace, type Workspace } from './helpers';
import { sha256 } from './hash';
import type { EditClip, EditProject, EditRenderProgress } from '../../src/shared/types/domain';

let ws: Workspace;
let dir: string;

function ff(args: string[], out: string): string {
  const r = spawnSync(process.env['FFMPEG_PATH'] ?? 'ffmpeg', ['-v', 'error', '-y', ...args, out], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}

interface Probed {
  durationSec: number;
  width: number;
  height: number;
  streams: string[];
  fps: string;
}

function probe(file: string): Probed {
  const r = spawnSync(
    process.env['FFPROBE_PATH'] ?? 'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
    { encoding: 'utf8' },
  );
  const j = JSON.parse(r.stdout) as {
    format: { duration: string };
    streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const v = j.streams.find((s) => s.codec_type === 'video');
  return {
    durationSec: Number(j.format.duration),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    streams: j.streams.map((s) => s.codec_type),
    fps: v?.r_frame_rate ?? '',
  };
}

async function waitRender(renderId: string, timeoutMs = 240_000): Promise<EditRenderProgress> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = ws.events
      .filter((e) => e.channel === 'edit:render.progress')
      .map((e) => e.payload as EditRenderProgress)
      .filter((p) => p.renderId === renderId)
      .pop();
    if (last && last.status !== 'running') return last;
    if (Date.now() > deadline) throw new Error(`렌더 시간 초과 ${renderId} ${last?.stage ?? ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function clipFrom(file: string, over: Partial<EditClip> = {}): Promise<EditClip> {
  const info = await ws.services.videoEdit.probeSource(file);
  return {
    id: crypto.randomUUID(),
    path: info.path,
    fileName: info.fileName,
    sourceDurationSec: info.durationSec ?? 0,
    sourceWidth: info.width ?? 0,
    sourceHeight: info.height ?? 0,
    hasAudio: info.hasAudio,
    inSec: 0,
    outSec: info.durationSec ?? 0,
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

beforeAll(async () => {
  ws = createWorkspace();
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-edit-'));
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('프로젝트와 소스', () => {
  it('프로젝트를 만들고 저장·목록·삭제할 수 있으며, 잘못된 구간은 거부한다', async () => {
    const p = ws.services.videoEdit.create('테스트 프로젝트');
    expect(ws.services.videoEdit.list().map((s) => s.id)).toContain(p.id);
    const video = copyFixture(ws, 'h264_sdr.mp4');
    const clip = await clipFrom(video);
    const saved = ws.services.videoEdit.save({ ...p, clips: [clip] });
    expect(saved.clips).toHaveLength(1);
    expect(ws.services.videoEdit.list().find((s) => s.id === p.id)?.clipCount).toBe(1);
    expect(() =>
      ws.services.videoEdit.save({ ...saved, clips: [{ ...clip, inSec: 2, outSec: 1 }] }),
    ).toThrow();
    expect(() =>
      ws.services.videoEdit.save({ ...saved, clips: [{ ...clip, outSec: 999 }] }),
    ).toThrow();
    expect(ws.services.videoEdit.delete(p.id)).toBe(true);
    expect(() => ws.services.videoEdit.get(p.id)).toThrow();
  });

  it('소스 확인은 영상·음성·이미지를 구분하고, 프레임 URL 은 토큰이다', async () => {
    const video = copyFixture(ws, 'h264_sdr.mp4');
    const wav = ff(
      ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'],
      path.join(dir, 'tone.wav'),
    );
    const png = ff(
      [
        '-f',
        'lavfi',
        '-i',
        'color=c=blue@0.8:size=200x80,format=rgba',
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgba',
      ],
      path.join(dir, 'logo.png'),
    );
    expect(await ws.services.videoEdit.probeSource(video)).toMatchObject({
      kind: 'video',
      hasAudio: true,
      hasVideo: true,
      width: 640,
      height: 360,
    });
    expect(await ws.services.videoEdit.probeSource(wav)).toMatchObject({
      kind: 'audio',
      hasAudio: true,
      hasVideo: false,
    });
    expect(await ws.services.videoEdit.probeSource(png)).toMatchObject({
      kind: 'image',
      hasVideo: true,
      width: 200,
    });
    const f = await ws.services.videoEdit.frame(video, 1.5);
    expect(f.url).toMatch(/^vslim-media:\/\/file\//);
  });
});

describe('렌더', () => {
  it('두 클립(속도·구간·전환·텍스트) + 음악 + 워터마크 + 손떨림 보정을 내보내고 ffprobe 로 길이·해상도·트랙을 확인한다', async () => {
    const a = copyFixture(ws, 'h264_sdr.mp4'); // 3초, 음성 있음
    const b = copyFixture(ws, 'no_audio.mp4'); // 음성 없음
    const hashA = sha256(a);
    const wav = ff(
      ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'],
      path.join(dir, 'bgm.wav'),
    );
    const png = ff(
      [
        '-f',
        'lavfi',
        '-i',
        'color=c=blue@0.8:size=200x80,format=rgba',
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgba',
      ],
      path.join(dir, 'wm.png'),
    );
    const p0 = ws.services.videoEdit.create('내보내기');
    const clipA = await clipFrom(a, {
      inSec: 0.5,
      outSec: 2.5,
      speed: 2, // 1초
      stabilize: true,
      transition: { type: 'fade', durationSec: 0.4 },
      texts: [
        {
          id: 't',
          text: '안녕하세요 Hello',
          x: 'center',
          y: 'bottom',
          fontSize: 60,
          color: '#ffff00',
          boxed: true,
          startSec: 0,
          endSec: null,
        },
      ],
    });
    const clipB = await clipFrom(b, {
      inSec: 0,
      outSec: 2,
      rotate: 90,
      filters: { brightness: 0.1, contrast: 1.1, saturation: 1.2, sharpen: 0.5, denoise: 1 },
    }); // 2초
    const project: EditProject = {
      ...p0,
      clips: [clipA, clipB],
      music: {
        path: wav,
        fileName: 'bgm.wav',
        sourceDurationSec: 2,
        volume: 0.5,
        fadeInSec: 0.3,
        fadeOutSec: 0.5,
        loop: true,
        originalMix: 0.8,
      },
      watermark: { path: png, fileName: 'wm.png', position: 'topright', scale: 0.2, opacity: 0.6 },
      canvas: { preset: '720p', fps: 24 },
      output: { container: 'mp4', codec: 'h264', crf: 28, preset: 'veryfast' },
    };
    ws.services.videoEdit.save(project);

    const renderId = ws.services.videoEdit.render(project.id, 'export', {
      kind: 'suffix',
      suffix: '-edit',
    });
    const done = await waitRender(renderId);
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.outputPath).toBe(path.join(path.dirname(a), '내보내기-edit.mp4'));
    const pr = probe(done.outputPath!);
    // 1초 + 2초 - 전환 0.4초 = 2.6초
    expect(Math.abs(pr.durationSec - 2.6)).toBeLessThan(0.3);
    expect(pr).toMatchObject({ width: 1280, height: 720, fps: '24/1' });
    expect(pr.streams.sort()).toEqual(['audio', 'video']);
    expect(sha256(a)).toBe(hashA);
    // 진행률 이벤트에 손떨림 분석 단계가 있었다
    const stages = ws.events
      .filter((e) => e.channel === 'edit:render.progress')
      .map((e) => (e.payload as EditRenderProgress).stage);
    expect(stages.some((s) => s.startsWith('손떨림 분석'))).toBe(true);
    // 결과가 previews 에 재생 가능한 행으로 등록된다
    expect(done.previewId).not.toBeNull();
    const src = await ws.services.previews.source({ kind: 'preview', id: done.previewId! });
    expect(src.mediaKind).toBe('video');
    // 임시 파일·디렉터리가 남지 않는다
    expect(fs.readdirSync(path.dirname(a)).filter((n) => n.includes('.vslim-tmp-'))).toHaveLength(
      0,
    );
    expect(fs.readdirSync(ws.services.tempRoot).filter((n) => n.startsWith('edit-'))).toHaveLength(
      0,
    );
  }, 300_000);

  it('미리보기 렌더는 640px 이하 저화질이고 같은 이름 내보내기는 번호를 붙이며, 취소하면 파일이 남지 않는다', async () => {
    const a = copyFixture(ws, 'h264_sdr.mp4');
    const p0 = ws.services.videoEdit.create('미리보기');
    const clip = await clipFrom(a, { inSec: 0, outSec: 2.5 });
    ws.services.videoEdit.save({
      ...p0,
      clips: [clip, { ...clip, id: 'second', transition: { type: 'none', durationSec: 1 } }],
    });

    const proxyId = ws.services.videoEdit.render(p0.id, 'proxy', null);
    const proxy = await waitRender(proxyId);
    expect(proxy.status, proxy.error ?? '').toBe('done');
    expect(proxy.outputPath).toBeNull();
    const rows = ws.services.previews.list(`editproject:${p0.id}`);
    expect(rows.some((r) => r.kind === 'editProxy')).toBe(true);
    const src = await ws.services.previews.source({ kind: 'preview', id: proxy.previewId! });
    expect(src.width).toBe(640);
    expect(src.height).toBe(360);

    const e1 = await waitRender(
      ws.services.videoEdit.render(p0.id, 'export', { kind: 'suffix', suffix: '-edit' }),
    );
    const e2 = await waitRender(
      ws.services.videoEdit.render(p0.id, 'export', { kind: 'suffix', suffix: '-edit' }),
    );
    expect(e1.outputPath).toBe(path.join(path.dirname(a), '미리보기-edit.mp4'));
    expect(e2.outputPath).toBe(path.join(path.dirname(a), '미리보기-edit (2).mp4'));

    const cancelId = ws.services.videoEdit.render(p0.id, 'export', {
      kind: 'suffix',
      suffix: '-cancel',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(ws.services.videoEdit.cancel(cancelId)).toBe(true);
    const cancelled = await waitRender(cancelId);
    expect(cancelled.status).toBe('cancelled');
    expect(fs.readdirSync(path.dirname(a)).filter((n) => n.includes('-cancel'))).toHaveLength(0);
  }, 300_000);
});
