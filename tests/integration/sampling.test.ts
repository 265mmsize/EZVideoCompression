/**
 * 샘플 품질 추천 통합 테스트 (실제 FFmpeg 로 SSIM 측정).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateCrfs } from '../../src/main/services/SampleEncodeService';
import { copyFixture, createWorkspace, waitForJob, type Workspace } from './helpers';

let ws: Workspace;

beforeAll(async () => {
  ws = createWorkspace('vslim-sample-');
  const st = await ws.services.refreshTools();
  if (!st.ready) throw new Error('FFmpeg 필요');
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
});

function makeClip(dir: string, seconds: number): string {
  const out = path.join(dir, `clip-${String(seconds)}s.mp4`);
  const r = spawnSync(
    process.env['FFMPEG_PATH'] ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=640x360:rate=30:duration=${String(seconds)}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      '-an',
      out,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}

describe('샘플 품질 추천', () => {
  it('길이 20초 영상에서 세 후보의 SSIM 과 용량 범위를 측정하고 추천을 저장한다', async () => {
    const dir = path.join(ws.root, 'sample-src');
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(ws.inputDir, 'sample-20s.mp4');
    fs.copyFileSync(makeClip(dir, 20), input);

    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    const job = await ws.services.queue.recommend(id);

    const rec = job.recommendation;
    expect(rec).not.toBeNull();
    expect(rec!.method).toBe('ssim');
    expect(rec!.threshold).toBe(0.97);
    expect(rec!.candidates.map((c) => c.crf)).toEqual(candidateCrfs(rec!.candidates[1]!.crf));
    for (const c of rec!.candidates) {
      expect(c.minSsim).toBeGreaterThanOrEqual(0);
      expect(c.minSsim).toBeLessThanOrEqual(1);
      expect(c.estVideoBytesMin).toBeLessThanOrEqual(c.estVideoBytesMax);
    }
    expect(rec!.sampleSegments.length).toBeGreaterThanOrEqual(2);
    expect(rec!.note).toContain('샘플');
    // 추천은 설정을 자동으로 바꾸지 않는다
    expect(job.settings.crf).toBeNull();
    expect(job.sampling).toBe(false);
    // 샘플 임시 파일은 남지 않는다
    expect(fs.existsSync(path.join(ws.services.tempRoot, `sample-${id}`))).toBe(false);
  }, 300_000);

  it('추천을 취소하면 기록 없이 끝나고 원본은 그대로다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    const pending = ws.services.queue.recommend(id);
    ws.services.queue.cancelRecommend(id);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(ws.services.queue.get(id).recommendation).toBeNull();
  }, 120_000);
});
