/**
 * 작업 큐 동작 통합 테스트: 일시정지, 취소, 목표 용량 상한, 중단 복구, 순서 변경.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFixture, createWorkspace, waitForJob, type Workspace } from './helpers';
import { sha256 } from './hash';

let ws: Workspace;

beforeAll(async () => {
  ws = createWorkspace('vslim-queue-');
  const st = await ws.services.refreshTools();
  if (!st.ready) throw new Error('FFmpeg 필요');
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
});

/** 취소 테스트용: 인코딩에 수 초가 걸리는 1080p 영상 */
function makeLongClip(dir: string): string {
  const out = path.join(dir, 'long-1080p.mp4');
  const res = spawnSync(
    process.env['FFMPEG_PATH'] ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=30',
      '-t',
      '40',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-an',
      out,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(res.stderr);
  return out;
}

describe('일시정지: 현재 작업 완료 후 다음 작업 시작 중지', () => {
  it('일시정지 상태에서는 대기열이 실행되지 않고, 재개하면 실행된다', async () => {
    const a = copyFixture(ws, 'no_audio.mp4');
    const b = copyFixture(ws, 'no_audio.mp4');
    const added = ws.services.queue.addPaths([a, b], false).added.map((j) => j.id);
    await waitForJob(ws, added[1]!, (j) => j.status === 'ready' || j.status === 'failed');

    ws.services.queue.setPaused(true);
    ws.services.queue.start(added);
    await new Promise((r) => setTimeout(r, 400));
    expect(ws.services.queue.queueState().runningJobId).toBeNull();
    expect(ws.services.queue.get(added[0]!).status).toBe('queued');

    ws.services.queue.setPaused(false);
    await waitForJob(ws, added[0]!, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );
    await waitForJob(ws, added[1]!, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );
  }, 300_000);
});

describe('취소', () => {
  it('인코딩 중 취소하면 취소됨으로 끝나고 임시 파일은 남지 않으며 원본은 그대로다', async () => {
    const longDir = path.join(ws.root, 'long');
    fs.mkdirSync(longDir, { recursive: true });
    const src = makeLongClip(longDir);
    const input = path.join(ws.inputDir, 'cancel-target.mp4');
    fs.copyFileSync(src, input);
    const before = sha256(input);

    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    ws.services.queue.start([id]);
    await waitForJob(
      ws,
      id,
      (j) => j.status === 'encoding' && (j.progress.ratio ?? 0) > 0.05,
      120_000,
    );

    ws.services.queue.cancel(id);
    const done = await waitForJob(ws, id, (j) => j.status === 'cancelled', 60_000);
    expect(done.outputPath).toBeNull();
    expect(sha256(input)).toBe(before);
    const leftovers = fs.readdirSync(ws.inputDir).filter((n) => n.includes('.vslim-tmp-'));
    expect(leftovers).toEqual([]);
    expect(ws.services.proc.liveCount).toBe(0);
  }, 300_000);
});

describe('목표 용량 모드', () => {
  it('결과가 목표 용량을 넘으면 성공으로 표시하지 않는다 (상한 있는 재시도 후 실패 또는 이하 결과)', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    const target = 1; // MiB
    ws.services.queue.updateSettings(id, { mode: 'target', targetMiB: target });
    const cur = ws.services.queue.get(id);
    if (cur.analysis?.support === 'blocked') {
      // 목표가 음성만으로도 부족하면 차단되는 것이 올바른 동작이다
      expect(cur.analysis.limitations.map((l) => l.code)).toContain('TARGET_TOO_SMALL');
      return;
    }
    ws.services.queue.start([id]);
    const done = await waitForJob(
      ws,
      id,
      (j) => ['completed', 'no_savings', 'failed'].includes(j.status),
      240_000,
    );
    if (done.status === 'failed') {
      expect(done.errorCode).toBe('TARGET_EXCEEDED');
    } else if (done.outputSizeBytes !== null) {
      expect(done.outputSizeBytes).toBeLessThanOrEqual(target * 1024 * 1024);
    }
  }, 300_000);
});

describe('중단 복구', () => {
  it('인코딩 중 종료된 작업은 중단됨으로 바뀌고 앱 임시 파일만 정리된다', () => {
    const input = copyFixture(ws, 'no_audio.mp4');
    const added = ws.services.queue.addPaths([input], false).added[0]!;
    const tempDir = path.join(ws.services.tempRoot, added.id);
    fs.mkdirSync(tempDir, { recursive: true });
    const tempOut = path.join(path.dirname(input), '.x-slim.vslim-tmp-abcdef12.mp4');
    fs.writeFileSync(tempOut, 'partial');
    const userFile = path.join(path.dirname(input), 'user-keep.mp4');
    fs.writeFileSync(userFile, 'keep');
    // 앱 종료 상황을 흉내 내기 위해 DB 상태를 직접 인코딩 중으로 바꾼다
    ws.services.jobs.update(added.id, { status: 'encoding', tempOutputPath: tempOut, tempDir });

    const n = ws.services.queue.recoverInterrupted();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(ws.services.queue.get(added.id).status).toBe('interrupted');
    expect(fs.existsSync(tempOut)).toBe(false);
    expect(fs.existsSync(tempDir)).toBe(false);
    expect(fs.existsSync(userFile)).toBe(true);
  });
});

describe('순서 변경과 삭제', () => {
  it('위·아래 이동으로 대기 작업 순서가 바뀌고, 삭제해도 원본은 남는다', async () => {
    const files = [1, 2, 3].map(() => copyFixture(ws, 'no_audio.mp4'));
    const ids = ws.services.queue.addPaths(files, false).added.map((j) => j.id);
    for (const id of ids)
      await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    const moved = ws.services.queue.move(ids[2]!, 'up');
    expect(moved.map((j) => j.id).indexOf(ids[2]!)).toBeLessThan(
      moved.map((j) => j.id).indexOf(ids[1]!),
    );

    expect(ws.services.queue.remove(ids[0]!)).toBe(true);
    expect(fs.existsSync(files[0]!)).toBe(true);
  }, 120_000);
});
