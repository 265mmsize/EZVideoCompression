/**
 * 영상 편집 마무리 기능을 실제 FFmpeg 로 확인한다:
 * HDR 원본 동의 절차와 톤 매핑, 무손실 합치기(패킷 수 보존), 클립 사이 음량 맞춤,
 * 하드웨어 인코더 실패 시 CPU 대체, 가변 프레임 속도 영상 합치기의 영상·음성 길이.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';
import type {
  EditClip,
  EditProject,
  EditRenderProgress,
  HardwareEncoderStatus,
} from '../../src/shared/types/domain';

let ws: Workspace;
let dir: string;
const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
const FFPROBE = process.env['FFPROBE_PATH'] ?? 'ffprobe';

function ff(args: string[]): void {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

function probeJson(file: string, entries: string): Record<string, unknown> {
  const r = spawnSync(
    FFPROBE,
    ['-v', 'error', '-count_packets', '-show_entries', entries, '-of', 'json', file],
    {
      encoding: 'utf8',
    },
  );
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function streamsOf(file: string): Record<string, string>[] {
  return (
    probeJson(
      file,
      'stream=codec_type,pix_fmt,color_transfer,nb_read_packets,duration,avg_frame_rate,r_frame_rate',
    ) as {
      streams: Record<string, string>[];
    }
  ).streams;
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
  if (!m?.[1]) throw new Error(`음량을 읽지 못했습니다: ${r.stderr.slice(-300)}`);
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

async function clipFrom(file: string): Promise<EditClip> {
  const info = await ws.services.videoEdit.probeSource(file);
  return {
    id: crypto.randomUUID(),
    path: info.path,
    fileName: info.fileName,
    sourceDurationSec: info.durationSec ?? 0,
    sourceWidth: info.width ?? 0,
    sourceHeight: info.height ?? 0,
    hasAudio: info.hasAudio,
    hdr: info.hdr,
    bitDepth: info.bitDepth,
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
  };
}

function saveProject(
  name: string,
  clips: EditClip[],
  output: Partial<EditProject['output']> = {},
): EditProject {
  const p0 = ws.services.videoEdit.create(name);
  const p: EditProject = {
    ...p0,
    clips,
    output: { container: 'mp4', codec: 'h264', crf: 26, preset: 'veryfast', ...output },
  };
  ws.services.videoEdit.save(p);
  return p;
}

/** 같은 형식의 짧은 영상 (색과 음 높이만 다르다) */
function makeClip(
  file: string,
  color: string,
  freq: number,
  sec: number,
  volume = 0.5,
  size = '640x360',
): void {
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${size}:r=30:d=${String(sec)}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${String(freq)}:sample_rate=48000:duration=${String(sec)}`,
    '-af',
    `volume=${String(volume)}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '30',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-shortest',
    file,
  ]);
}

beforeAll(async () => {
  ws = createWorkspace('vslim-finish-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  dir = path.join(ws.root, '마무리 자료');
  fs.mkdirSync(dir, { recursive: true });
  makeClip(path.join(dir, '가.mp4'), 'red', 440, 2);
  makeClip(path.join(dir, '나.mp4'), 'blue', 660, 2);
  makeClip(path.join(dir, '큰화면.mp4'), 'green', 550, 2, 0.5, '1280x720');
  makeClip(path.join(dir, '작은소리.mp4'), 'gray', 440, 3, 0.03);
  makeClip(path.join(dir, '큰소리.mp4'), 'white', 440, 3, 0.9);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2',
    '-pix_fmt',
    'yuv420p10le',
    '-c:v',
    'libx265',
    '-x265-params',
    'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
    '-color_primaries',
    'bt2020',
    '-color_trc',
    'smpte2084',
    '-colorspace',
    'bt2020nc',
    '-c:a',
    'aac',
    '-shortest',
    path.join(dir, 'HDR.mp4'),
  ]);
  // 가변 프레임 속도: 처음 1초는 30fps, 그 뒤는 3프레임 중 1개만 남긴다
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=30:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=3',
    '-vf',
    "select='lt(n\\,30)+not(mod(n\\,3))'",
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    path.join(dir, '가변.mp4'),
  ]);
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('HDR 원본', () => {
  it('동의 없이 내보내면 이유를 알리고 멈추고, 동의하면 톤 매핑해 SDR 8비트로 낸다', async () => {
    const hdr = await clipFrom(path.join(dir, 'HDR.mp4'));
    expect(hdr.hdr).toBe(true);
    expect(hdr.bitDepth).toBe(10);
    const p = saveProject('HDR 막기', [hdr]);
    const refused = await waitRender(
      ws.services.videoEdit.render(p.id, 'export', { kind: 'suffix', suffix: '-x' }),
    );
    expect(refused.status).toBe('failed');
    expect(refused.error).toContain('HDR·10비트 원본');
    expect(refused.error).toContain('HDR.mp4: HDR → SDR');

    ws.services.videoEdit.save({
      ...ws.services.videoEdit.get(p.id),
      output: { ...p.output, hdrToSdr: true },
    });
    const done = await waitRender(
      ws.services.videoEdit.render(p.id, 'export', { kind: 'suffix', suffix: '-sdr' }),
    );
    expect(done.status, done.error ?? '').toBe('done');
    const v = streamsOf(done.outputPath ?? '').find((s) => s['codec_type'] === 'video');
    expect(v?.['pix_fmt']).toBe('yuv420p');
    expect(v?.['color_transfer']).not.toBe('smpte2084');
  }, 300_000);
});

describe('무손실 합치기', () => {
  it('같은 형식의 두 파일은 재인코딩 없이 합쳐진다 (패킷 수가 그대로)', async () => {
    const a = await clipFrom(path.join(dir, '가.mp4'));
    const b = await clipFrom(path.join(dir, '나.mp4'));
    const p = saveProject('무손실', [a, b]);
    expect(await ws.services.videoEdit.losslessCheck(p.id)).toEqual({ ok: true, reasons: [] });
    const done = await waitRender(ws.services.videoEdit.losslessMerge(p.id, null));
    expect(done.status, done.error ?? '').toBe('done');
    const out = done.outputPath ?? '';
    expect(path.basename(out)).toBe('무손실-merge.mp4');
    const packets = (file: string): number =>
      Number(streamsOf(file).find((s) => s['codec_type'] === 'video')?.['nb_read_packets'] ?? 0);
    expect(packets(out)).toBe(packets(a.path) + packets(b.path));
    const dur = Number(
      (probeJson(out, 'format=duration') as { format: { duration: string } }).format.duration,
    );
    expect(Math.abs(dur - 4)).toBeLessThan(0.2);
  }, 120_000);

  it('크기가 다르거나 효과가 있으면 이유를 알려 주고 합치지 않는다', async () => {
    const a = await clipFrom(path.join(dir, '가.mp4'));
    const big = await clipFrom(path.join(dir, '큰화면.mp4'));
    const p = saveProject('무손실 불가', [a, big]);
    const check = await ws.services.videoEdit.losslessCheck(p.id);
    expect(check.ok).toBe(false);
    expect(check.reasons.join('\n')).toContain('큰화면.mp4: 가로 크기가 첫 파일과 다릅니다');
    const withText = saveProject('텍스트', [
      {
        ...a,
        texts: [
          {
            id: 't',
            text: '자막',
            x: 'center',
            y: 'bottom',
            fontSize: 40,
            color: '#fff',
            boxed: false,
            startSec: 0,
            endSec: null,
          },
        ],
      },
      { ...a, id: crypto.randomUUID() },
    ]);
    expect((await ws.services.videoEdit.losslessCheck(withText.id)).reasons).toContain(
      '가.mp4: 텍스트가 있습니다',
    );
    const refused = await waitRender(ws.services.videoEdit.losslessMerge(p.id, null));
    expect(refused.status).toBe('failed');
  }, 120_000);
});

describe('클립 사이 음량 맞춤', () => {
  it('작은 소리와 큰 소리 클립의 차이가 3dB 안으로 줄어든다', async () => {
    const quiet = await clipFrom(path.join(dir, '작은소리.mp4'));
    const loud = await clipFrom(path.join(dir, '큰소리.mp4'));
    const before = meanVolume(loud.path, 0.5, 2) - meanVolume(quiet.path, 0.5, 2);
    expect(before).toBeGreaterThan(20);
    const p = saveProject('음량', [quiet, loud], { normalizeAudio: true });
    const done = await waitRender(
      ws.services.videoEdit.render(p.id, 'export', { kind: 'suffix', suffix: '-loud' }),
    );
    expect(done.status, done.error ?? '').toBe('done');
    const out = done.outputPath ?? '';
    const after = Math.abs(meanVolume(out, 3.5, 2) - meanVolume(out, 0.5, 2));
    expect(after).toBeLessThan(3);
  }, 300_000);
});

describe('하드웨어 인코더', () => {
  it('하드웨어 인코더가 실패하면 CPU 인코더로 다시 렌더해 결과를 낸다', async () => {
    const a = await clipFrom(path.join(dir, '가.mp4'));
    const p = saveProject('하드웨어', [a], { hardware: true });
    // 이 환경에는 GPU 가 없으므로 NVENC 를 "사용 가능"으로 속이면 실제 인코딩에서 실패한다
    const svc = ws.services.videoEdit as unknown as {
      deps: { hardwareStatuses: () => HardwareEncoderStatus[] };
    };
    const original = svc.deps.hardwareStatuses;
    svc.deps.hardwareStatuses = () => [
      { name: 'h264_nvenc', family: 'nvenc', codec: 'h264', available: true, reason: null },
    ];
    try {
      const id = ws.services.videoEdit.render(p.id, 'export', { kind: 'suffix', suffix: '-hw' });
      const done = await waitRender(id);
      expect(done.status, done.error ?? '').toBe('done');
      const stages = ws.events
        .filter((e) => e.channel === 'edit:render.progress')
        .map((e) => e.payload as EditRenderProgress)
        .filter((x) => x.renderId === id)
        .map((x) => x.stage);
      expect(stages.some((s) => s.includes('h264_nvenc'))).toBe(true);
      expect(stages.some((s) => s.includes('CPU 로 다시'))).toBe(true);
      expect(fs.existsSync(done.outputPath ?? '')).toBe(true);
    } finally {
      svc.deps.hardwareStatuses = original;
    }
  }, 300_000);
});

describe('가변 프레임 속도 영상', () => {
  it('가변 프레임 영상을 다른 영상과 합쳐도 영상과 음성 길이가 맞는다', async () => {
    const vfrInfo = streamsOf(path.join(dir, '가변.mp4')).find((s) => s['codec_type'] === 'video');
    // 원본이 실제로 가변 프레임인지 (평균과 명목 프레임 속도가 다르다)
    expect(vfrInfo?.['avg_frame_rate']).not.toBe(vfrInfo?.['r_frame_rate']);
    const vfr = await clipFrom(path.join(dir, '가변.mp4'));
    const cfr = await clipFrom(path.join(dir, '가.mp4'));
    const p = saveProject('가변 합치기', [vfr, cfr]);
    const done = await waitRender(
      ws.services.videoEdit.render(p.id, 'export', { kind: 'suffix', suffix: '-vfr' }),
    );
    expect(done.status, done.error ?? '').toBe('done');
    const st = streamsOf(done.outputPath ?? '');
    const vDur = Number(st.find((s) => s['codec_type'] === 'video')?.['duration']);
    const aDur = Number(st.find((s) => s['codec_type'] === 'audio')?.['duration']);
    expect(Math.abs(vDur - 5)).toBeLessThan(0.15);
    expect(Math.abs(aDur - vDur)).toBeLessThan(0.1);
    // 결과는 고정 프레임 속도 (30fps × 5초)
    const frames = Number(st.find((s) => s['codec_type'] === 'video')?.['nb_read_packets']);
    expect(Math.abs(frames - 150)).toBeLessThanOrEqual(3);
  }, 300_000);
});
