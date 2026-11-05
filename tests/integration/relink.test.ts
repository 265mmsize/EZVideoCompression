/** 원본을 지운 뒤 다시 연결: 없는 원본을 찾고, 새 파일로 바꾸고, 저장한다 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';
import type { EditClip } from '../../src/shared/types/domain';

let ws: Workspace;
let dir: string;

beforeAll(async () => {
  ws = createWorkspace('vslim-relink-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  dir = path.join(ws.root, '재연결 자료');
  fs.mkdirSync(dir, { recursive: true });
}, 120_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('원본 다시 연결 (파일)', () => {
  it('원본이 없으면 찾고, 새 파일로 다시 연결해 저장한다', async () => {
    const original = path.join(dir, '옛 위치.mp4');
    fs.copyFileSync(ws.fixtures['h264_sdr.mp4'], original);
    const info = await ws.services.videoEdit.probeSource(original);
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
    const p0 = ws.services.videoEdit.create('재연결');
    ws.services.videoEdit.save({ ...p0, clips: [clip] });

    // 원본을 옮긴다 (옛 위치에서 사라짐)
    const moved = path.join(dir, '새 위치.mp4');
    fs.renameSync(original, moved);
    const missing = ws.services.videoEdit.missingSources(p0.id);
    expect(missing).toEqual([{ role: 'clip', path: original, fileName: '옛 위치.mp4' }]);

    const res = await ws.services.videoEdit.relinkSource(p0.id, original, moved);
    expect(res.project.clips[0]?.path).toBe(moved);
    expect(res.project.clips[0]?.fileName).toBe('새 위치.mp4');
    expect(ws.services.videoEdit.get(p0.id).clips[0]?.path).toBe(moved);
    expect(ws.services.videoEdit.missingSources(p0.id)).toEqual([]);
  }, 120_000);
});
