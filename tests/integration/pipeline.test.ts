/**
 * 실제 FFmpeg 로 수행하는 파이프라인 통합 테스트.
 * 분석 → 큐 실행 → 검증 → 확정까지 실제 파일로 확인한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFixture, createWorkspace, waitForJob, type Workspace } from './helpers';
import { sha256 } from './hash';

let ws: Workspace;

beforeAll(async () => {
  ws = createWorkspace();
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('도구 탐지', () => {
  it('ffmpeg/ffprobe 를 찾고 libx264·libx265 인코더를 확인한다', () => {
    const st = ws.services.toolStatus();
    expect(st?.ready).toBe(true);
    expect(st?.encoders).toEqual(expect.arrayContaining(['libx264', 'libx265']));
  });
});

describe('단일 영상 고품질 압축 (실제 인코딩)', () => {
  it('원본은 바이트 단위로 변하지 않고, 결과는 검증 후 -slim 이름으로 확정된다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    const before = sha256(input);
    const beforeSize = fs.statSync(input).size;

    const { added } = ws.services.queue.addPaths([input], false);
    expect(added).toHaveLength(1);
    const id = added[0]!.id;

    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    const ready = ws.services.queue.get(id);
    expect(ready.status).toBe('ready');
    expect(ready.analysis?.support).toBe('supported');

    ws.services.queue.start([id]);
    const done = await waitForJob(ws, id, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );

    expect(done.errorDetail).toBeNull();
    // 원본 보호
    expect(sha256(input)).toBe(before);
    expect(fs.statSync(input).size).toBe(beforeSize);

    // 결과 확정: 같은 폴더에 -slim.mp4 (또는 중복 번호)
    expect(done.status === 'completed' || done.status === 'no_savings').toBe(true);
    if (done.status === 'completed') {
      expect(done.outputPath).not.toBeNull();
      expect(path.basename(done.outputPath!)).toMatch(/-slim( \(\d+\))?\.mp4$/);
      expect(fs.existsSync(done.outputPath!)).toBe(true);
      expect(done.validation?.passed).toBe(true);
      expect(done.validation?.basicOnly).toBe(true);
      expect(done.encoderName).toContain('libx264');
    }
    // 임시 파일이 남지 않는다
    const leftovers = fs.readdirSync(path.dirname(input)).filter((n) => n.includes('.vslim-tmp-'));
    expect(leftovers).toEqual([]);
  }, 300_000);
});

describe('원본 유지(copy) 모드', () => {
  it('영상 스트림을 재인코딩하지 않고 패킷 수가 같아야 한다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    const { added } = ws.services.queue.addPaths([input], false);
    const id = added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    ws.services.queue.updateSettings(id, { mode: 'copy', container: 'mkv' });
    ws.services.queue.start([id]);
    const done = await waitForJob(ws, id, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );
    expect(done.errorDetail).toBeNull();
    const packets = done.validation?.checks.find((c) => c.id === 'packets');
    expect(packets?.passed).toBe(true);
  }, 300_000);
});

describe('다중 음성·자막 트랙 보존', () => {
  it('MKV 입력의 음성 2개와 자막을 MKV 출력에서 모두 유지한다', async () => {
    const input = copyFixture(ws, 'subtitle.mkv');
    const { added } = ws.services.queue.addPaths([input], false);
    const id = added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    ws.services.queue.updateSettings(id, { container: 'mkv' });
    ws.services.queue.start([id]);
    const done = await waitForJob(ws, id, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );
    expect(done.errorDetail).toBeNull();
    const subs = done.validation?.checks.find((c) => c.id === 'tracks-subtitle');
    expect(subs?.passed).toBe(true);
  }, 300_000);
});

describe('실패 처리', () => {
  it('손상된 입력은 앱을 죽이지 않고 failed 로 표시한다', async () => {
    const input = copyFixture(ws, 'corrupt.mp4');
    const { added } = ws.services.queue.addPaths([input], false);
    const id = added[0]!.id;
    const job = await waitForJob(ws, id, (j) => ['ready', 'failed'].includes(j.status));
    expect(job.status).toBe('failed');
    expect(job.errorCode).toBe('PROBE_FAILED');
  }, 120_000);

  it('10비트 영상을 H.264 로 바꾸는 설정은 차단되고 실행되지 않는다', async () => {
    const input = copyFixture(ws, 'hevc_10bit.mkv');
    const { added } = ws.services.queue.addPaths([input], false);
    const id = added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    const updated = ws.services.queue.updateSettings(id, { codec: 'h264' });
    expect(updated.analysis?.support).toBe('blocked');
    expect(() => ws.services.queue.start([id])).not.toThrow();
    expect(ws.services.queue.get(id).status).toBe('ready');
  }, 120_000);
});

describe('원본 덮어쓰기 금지', () => {
  it('같은 경로 중복 등록은 거부된다', async () => {
    const input = copyFixture(ws, 'no_audio.mp4');
    const first = ws.services.queue.addPaths([input], false);
    const second = ws.services.queue.addPaths([input], false);
    expect(first.added).toHaveLength(1);
    expect(second.added).toHaveLength(0);
    expect(second.skipped[0]?.reason).toContain('이미 목록');
  }, 60_000);
});
