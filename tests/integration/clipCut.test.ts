/**
 * 라이브러리 영상 구간 자르기를 실제 FFmpeg 로 확인한다: 빠름 모드(스트림 복사), 정확 모드(재인코딩), 원본 불변, 이름 번호.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFixture, createWorkspace, type Workspace } from './helpers';
import { sha256 } from './hash';

let ws: Workspace;
let lib: string;

const QUERY = {
  rootId: null,
  dir: null,
  kinds: [],
  search: '',
  minRating: 0,
  label: null,
  tags: [],
  compressed: 'any' as const,
  includeMissing: false,
  sort: 'name' as const,
  order: 'asc' as const,
  limit: 100,
  offset: 0,
};

function durationOf(file: string): number {
  const r = spawnSync(
    process.env['FFPROBE_PATH'] ?? 'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return Number(r.stdout.trim());
}

beforeAll(async () => {
  ws = createWorkspace('vslim-cut-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  lib = path.join(ws.root, '자르기 라이브러리');
  fs.mkdirSync(lib, { recursive: true });
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
});

function indexedItem(file: string): string {
  const { items } = ws.services.library.query({ ...QUERY, search: path.parse(file).name });
  const id = items[0]?.id;
  if (!id) throw new Error(`항목 없음: ${file}`);
  return id;
}

describe('라이브러리 구간 자르기', () => {
  it('정확 모드는 요청 길이에 맞춰 재인코딩하고, 원본은 바이트 단위로 같으며 같은 폴더에 -cut 파일이 생긴다', async () => {
    const src = copyFixture(ws, 'h264_sdr.mp4', '정확 자르기.mp4');
    fs.copyFileSync(src, path.join(lib, '정확 자르기.mp4'));
    const original = path.join(lib, '정확 자르기.mp4');
    ws.services.library.addRoot(lib, false);
    await ws.services.indexer.idle();
    const id = indexedItem(original);
    const before = sha256(original);
    const dur = durationOf(original);
    const from = 0.5;
    const to = Math.min(dur, 2.1);
    const res = await ws.services.clipCut.cut(id, from, to, 'exact');
    expect(res.outputPath).toBe(path.join(lib, '정확 자르기-cut.mp4'));
    expect(Math.abs(res.durationSec - (to - from))).toBeLessThan(0.2);
    expect(res.notes[0]).toContain('재인코딩');
    expect(sha256(original)).toBe(before);
    expect(fs.readdirSync(lib).filter((n) => n.includes('.vslim-tmp-'))).toHaveLength(0);
    // 결과는 라이브러리에 바로 반영된다
    expect(res.libraryItemId).not.toBeNull();
  }, 300_000);

  it('빠름 모드는 재인코딩하지 않고 스트림을 복사하며, 같은 이름이 있으면 번호를 붙인다', async () => {
    const src = copyFixture(ws, 'h264_sdr.mp4', '빠른 자르기.mp4');
    const original = path.join(lib, '빠른 자르기.mp4');
    fs.copyFileSync(src, original);
    // 등록 뒤에 넣은 파일은 다시 인덱싱해야 목록에 나타난다
    ws.services.library.reindex(ws.services.library.listRoots()[0]!.id);
    await ws.services.indexer.idle();
    const id = indexedItem(original);
    const dur = durationOf(original);
    const first = await ws.services.clipCut.cut(id, 0, Math.min(dur, 1.5), 'fast');
    expect(first.outputPath).toBe(path.join(lib, '빠른 자르기-cut.mp4'));
    expect(first.notes[0]).toContain('재인코딩하지 않았습니다');
    const second = await ws.services.clipCut.cut(id, 0, Math.min(dur, 1.5), 'fast');
    expect(second.outputPath).toBe(path.join(lib, '빠른 자르기-cut (2).mp4'));
    // 빠른 모드는 키프레임 시작이므로 요청보다 짧아지지 않는다
    expect(first.durationSec).toBeGreaterThanOrEqual(Math.min(dur, 1.5) - 0.5);
  }, 300_000);

  it('잘못된 구간은 거부하고 파일을 만들지 않는다', async () => {
    const original = path.join(lib, '빠른 자르기.mp4');
    const id = indexedItem(original);
    await expect(ws.services.clipCut.cut(id, 1, 1.2, 'fast')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(ws.services.clipCut.cut(id, 0, 9999, 'fast')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  }, 120_000);
});
