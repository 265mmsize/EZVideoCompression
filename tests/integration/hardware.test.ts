/**
 * 하드웨어 인코더 통합 테스트.
 * 이 테스트 환경에는 GPU 가 없으므로, 사용 불가 판정과 CPU 대체 경로를 실제 ffmpeg 로 확인한다.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeCapability } from '../../src/main/services/CapabilityService';
import { createWorkspace, copyFixture, waitForJob, type Workspace } from './helpers';
import type { JobSettings } from '../../src/shared/types/domain';

let ws: Workspace;

beforeAll(async () => {
  ws = createWorkspace('vslim-hw-');
  const st = await ws.services.refreshTools();
  if (!st.ready) throw new Error('FFmpeg 필요');
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('하드웨어 인코더 탐지', () => {
  it('여섯 개 후보(NVENC·QSV·AMF × H.264/H.265)를 모두 보고하고, 사용 불가 사유를 남긴다', () => {
    const hw = ws.services.toolStatus()?.hardwareEncoders ?? [];
    expect(hw).toHaveLength(6);
    for (const h of hw) {
      expect(h.available).toBe(false); // 이 환경에는 GPU 가 없다
      expect(h.reason).not.toBeNull();
    }
  });
});

describe('빠른 압축 CPU 대체', () => {
  it('사용 가능한 하드웨어 인코더가 없으면 CPU 로 인코딩하고 결과에 그 사실을 남긴다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    ws.services.queue.updateSettings(id, { mode: 'fast', codec: 'h264' });
    ws.services.queue.start([id]);
    const done = await waitForJob(ws, id, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );
    expect(done.errorDetail).toBeNull();
    expect(done.encoderName).toContain('libx264');
  }, 300_000);

  it('존재하지 않는 GPU 인코더를 요청하면 실패 대신 CPU 로 한 번 대체하고 그 사실을 기록한다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    const probeRes = await ws.services.runner.analyze(input, fastSettings(), 'hw-fallback', null);
    const outDir = path.dirname(input);
    const events: string[] = [];
    const controller = new AbortController();
    const outcome = await ws.services.runner.encode({
      jobId: '00000000-0000-4000-8000-00000000f00d',
      inputPath: input,
      inputSizeBytes: probeRes.probe.sizeBytes,
      inputMtimeMs: probeRes.probe.mtimeMs,
      settings: fastSettings(),
      probe: probeRes.probe,
      analysis: analyzeCapability(probeRes.probe, fastSettings()),
      outputDir: outDir,
      outputSuffix: '-slim',
      keepLargerResults: true,
      tempRoot: ws.services.tempRoot,
      reservedOutputs: new Set(),
      signal: controller.signal,
      historicalSpeed: null,
      hardwareEncoder: { name: 'h264_nvenc', family: 'nvenc' },
      callbacks: {
        onStatus: (s) => events.push(s),
        onProgress: () => undefined,
        onTempOutput: () => undefined,
        onEncoderVersion: () => undefined,
      },
    });
    expect(outcome.encoderName).toContain('CPU 로 대체');
    expect(outcome.encoderName).toContain('libx264');
    expect(outcome.validation.passed).toBe(true);
  }, 300_000);
});

function fastSettings(): JobSettings {
  return {
    mode: 'fast',
    preset: 'speed',
    container: 'mp4',
    codec: 'h264',
    targetMiB: null,
    videoStreamIndex: null,
    crf: null,
  };
}
