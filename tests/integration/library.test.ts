/**
 * 미디어 라이브러리 통합 테스트 (실제 FFmpeg): 인덱싱, 썸네일, 재생 판정, 프레임, 프록시, 설정 미리보기, 메타, 중복, 캐시.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreviewProgress } from '../../src/shared/types/domain';
import { tokenFromUrl } from '../../src/main/services/library/MediaTokenRegistry';
import { copyFixture, createWorkspace, waitForJob, type Workspace } from './helpers';

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

function makeImage(out: string, fmtArgs: string[]): void {
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
      'testsrc2=size=320x200:rate=1',
      '-frames:v',
      '1',
      ...fmtArgs,
      '-update',
      '1',
      out,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);
}

async function indexed(): Promise<void> {
  await ws.services.indexer.idle();
}

function fileOf(url: string): string {
  const entry = ws.services.tokens.resolve(tokenFromUrl(url) as string);
  if (!entry) throw new Error(`토큰 해석 실패: ${url}`);
  return entry.path;
}

function waitPreview(previewId: string, timeoutMs = 120_000): Promise<PreviewProgress> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const done = ws.events
        .filter((e) => e.channel === 'library:preview.progress')
        .map((e) => e.payload as PreviewProgress)
        .find((p) => p.previewId === previewId && p.status !== 'running');
      if (done) resolve(done);
      else if (Date.now() > deadline) reject(new Error('미리보기 시간 초과'));
      else setTimeout(tick, 50);
    };
    tick();
  });
}

beforeAll(async () => {
  ws = createWorkspace('vslim-lib-');
  await ws.services.refreshTools();
  lib = path.join(ws.root, '라이브러리 폴더');
  fs.mkdirSync(path.join(lib, 'sub', 'deep'), { recursive: true });
  fs.copyFileSync(ws.fixtures['h264_sdr.mp4'], path.join(lib, 'clip 1.mp4'));
  fs.copyFileSync(ws.fixtures['hevc_10bit.mkv'], path.join(lib, 'sub', 'hevc.mkv'));
  fs.copyFileSync(ws.fixtures['no_audio.mp4'], path.join(lib, 'sub', 'deep', 'silent.mp4'));
  fs.copyFileSync(ws.fixtures['h264_sdr.mp4'], path.join(lib, 'sub', 'dup-a.mp4'));
  fs.copyFileSync(ws.fixtures['h264_sdr.mp4'], path.join(lib, 'sub', 'dup-b.mp4'));
  makeImage(path.join(lib, 'photo.jpg'), ['-q:v', '3']);
  makeImage(path.join(lib, 'scan.tiff'), ['-pix_fmt', 'rgb24']);
  makeImage(path.join(lib, 'sub', 'art.png'), []);
  fs.writeFileSync(path.join(lib, 'notes.txt'), 'not media');
  fs.writeFileSync(path.join(lib, '.hidden.mp4'), 'hidden');
  fs.copyFileSync(ws.fixtures['corrupt.mp4'], path.join(lib, 'broken.mp4'));
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('폴더 등록과 인덱싱', () => {
  it('영상·이미지만 인덱싱하고 숨김·비미디어·손상 파일을 올바르게 다룬다', async () => {
    const root = ws.services.library.addRoot(lib, true);
    await indexed();
    const roots = ws.services.library.listRoots();
    expect(roots).toHaveLength(1);
    // clip 1, hevc, silent, dup-a, dup-b, photo, scan, art, broken(오류로 기록) = 9
    expect(roots[0]?.itemCount).toBe(9);
    const { items, total } = ws.services.library.query(QUERY);
    expect(total).toBe(9);
    expect(items.some((i) => i.fileName === '.hidden.mp4')).toBe(false);
    expect(items.some((i) => i.fileName === 'notes.txt')).toBe(false);
    const clip = items.find((i) => i.fileName === 'clip 1.mp4');
    expect(clip?.kind).toBe('video');
    expect(clip?.width).toBe(640);
    expect(clip?.durationSec).toBeCloseTo(3, 0);
    expect(clip?.videoCodec).toBe('h264');
    expect(clip?.audioCodec).toBe('aac');
    const photo = items.find((i) => i.fileName === 'photo.jpg');
    expect(photo?.kind).toBe('image');
    expect(photo?.width).toBe(320);
    expect(photo?.durationSec).toBeNull();
    const broken = items.find((i) => i.fileName === 'broken.mp4');
    expect(broken?.errorCode).toBe('PROBE_FAILED');
    const tree = ws.services.library.tree(root.id);
    expect(tree.children.map((c) => c.name)).toEqual(['sub']);
    expect(tree.children[0]?.children[0]?.name).toBe('deep');
  }, 180_000);

  it('같은 폴더나 하위 폴더는 다시 등록할 수 없다', () => {
    expect(() => ws.services.library.addRoot(lib, true)).toThrow(/이미 등록/);
    expect(() => ws.services.library.addRoot(path.join(lib, 'sub'), true)).toThrow(
      /상위 또는 하위/,
    );
  });

  it('필터: 종류·폴더·검색·정렬이 동작한다', () => {
    const images = ws.services.library.query({ ...QUERY, kinds: ['image'] });
    expect(images.total).toBe(3);
    const inSub = ws.services.library.query({ ...QUERY, dir: path.join(lib, 'sub') });
    expect(inSub.total).toBe(5); // hevc, dup-a, dup-b, art, deep/silent
    const search = ws.services.library.query({ ...QUERY, search: 'dup' });
    expect(search.items.map((i) => i.fileName)).toEqual(['dup-a.mp4', 'dup-b.mp4']);
    const bySize = ws.services.library.query({ ...QUERY, sort: 'size', order: 'desc', limit: 1 });
    expect(bySize.items[0]?.sizeBytes).toBeGreaterThan(0);
  });
});

describe('썸네일·스크럽·재생 판정·프레임', () => {
  it('영상과 이미지 썸네일을 만들고 토큰 URL 은 실제 JPEG 를 가리킨다', async () => {
    const { items } = ws.services.library.query(QUERY);
    const clip = items.find((i) => i.fileName === 'clip 1.mp4')!;
    const photo = items.find((i) => i.fileName === 'scan.tiff')!;
    for (const it of [clip, photo]) {
      const url = await ws.services.library.thumbUrl(it.id);
      expect(url).toMatch(/^vslim-media:\/\/file\/[0-9a-f]{32}$/);
      const file = fileOf(url!);
      const head = fs.readFileSync(file).subarray(0, 2);
      expect([head[0], head[1]]).toEqual([0xff, 0xd8]); // JPEG
    }
    // 같은 항목은 같은 URL (캐시 적중)
    expect(await ws.services.library.thumbUrl(clip.id)).toBe(
      await ws.services.library.thumbUrl(clip.id),
    );
    const scrub = await ws.services.library.scrubUrls(clip.id);
    expect(scrub.urls.length).toBe(3); // 3초 영상 → 3장
    expect(scrub.timesSec).toEqual([0.5, 1.5, 2.5]);
    expect(ws.services.library.cacheStats().thumbCount).toBeGreaterThanOrEqual(5);
  }, 120_000);

  it('H.264 MP4 는 직접 재생, HEVC MKV 는 프레임 경로, TIFF 는 변환본 URL', async () => {
    const { items } = ws.services.library.query(QUERY);
    const clip = items.find((i) => i.fileName === 'clip 1.mp4')!;
    const hevc = items.find((i) => i.fileName === 'hevc.mkv')!;
    const tiff = items.find((i) => i.fileName === 'scan.tiff')!;
    const s1 = await ws.services.previews.source({ kind: 'item', id: clip.id });
    expect(s1.capability.direct).toBe(true);
    expect(fileOf(s1.url)).toBe(clip.path);
    const s2 = await ws.services.previews.source({ kind: 'item', id: hevc.id });
    expect(s2.capability.direct).toBe(false);
    expect(s2.capability.reason).toContain('HEVC');
    const s3 = await ws.services.previews.source({ kind: 'item', id: tiff.id });
    expect(s3.capability.direct).toBe(true);
    expect(s3.capability.reason).toContain('변환본');
    expect(fileOf(s3.url)).not.toBe(tiff.path);
    const frame = await ws.services.previews.frame({ kind: 'item', id: hevc.id }, 1.23);
    expect(frame.timeSec).toBe(1.2);
    expect(fs.existsSync(fileOf(frame.url))).toBe(true);
  }, 120_000);

  it('프록시를 만들면 H.264 변환본이 생기고 직접 재생 가능하며, 변환본임이 표시된다', async () => {
    const { items } = ws.services.library.query(QUERY);
    const hevc = items.find((i) => i.fileName === 'hevc.mkv')!;
    const id = await ws.services.previews.createProxy(hevc.id);
    const done = await waitPreview(id);
    expect(done.status).toBe('done');
    expect(done.asset?.note).toContain('압축 결과가 아닙니다');
    const src = await ws.services.previews.source({ kind: 'preview', id });
    expect(src.capability.direct).toBe(true);
    expect(ws.services.previews.list(`item:${hevc.id}`)).toHaveLength(1);
    // 같은 항목에 다시 요청하면 기존 변환본을 돌려준다
    expect(await ws.services.previews.createProxy(hevc.id)).toBe(id);
  }, 180_000);

  it('프록시 생성을 취소하면 파일이 남지 않는다', async () => {
    const big = path.join(ws.root, 'big.mp4');
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
        'testsrc2=size=1920x1080:rate=30',
        '-t',
        '30',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-x265-params',
        'log-level=error',
        '-an',
        big,
      ],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    const dir = path.join(ws.root, 'bigroot');
    fs.mkdirSync(dir);
    fs.renameSync(big, path.join(dir, 'big.mp4'));
    const root = ws.services.library.addRoot(dir, false);
    await indexed();
    const item = ws.services.library.query({ ...QUERY, rootId: root.id }).items[0]!;
    const id = await ws.services.previews.createProxy(item.id);
    await new Promise((r2) => setTimeout(r2, 800));
    expect(ws.services.previews.cancel(id)).toBe(true);
    const done = await waitPreview(id);
    expect(done.status).toBe('cancelled');
    expect(fs.readdirSync(path.join(ws.userData, 'previews')).some((n) => n.startsWith(id))).toBe(
      false,
    );
    ws.services.library.removeRoot(root.id);
  }, 180_000);
});

describe('설정 미리보기와 압축 연결', () => {
  it('작업 설정으로 구간을 인코딩하되 작업 결과로 저장하지 않는다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    const jobId = ws.services.queue.addPaths([input], false).added[0]!.id;
    await waitForJob(ws, jobId, (j) => j.status === 'ready');
    const id = ws.services.previews.createSettingsPreview(jobId, 0.5, 1.5);
    const done = await waitPreview(id);
    expect(done.status).toBe('done');
    expect(done.asset?.kind).toBe('settings');
    expect(done.asset?.settings?.mode).toBe('quality');
    expect(done.asset?.durationSec).toBeCloseTo(1.5, 1);
    expect(ws.services.queue.get(jobId).status).toBe('ready');
    expect(ws.services.queue.get(jobId).outputPath).toBeNull();
    const src = await ws.services.previews.source({ kind: 'preview', id });
    expect(src.capability.direct).toBe(true);
    // 작업 입력을 참조로 프레임을 뽑을 수 있다 (비교 화면의 왼쪽)
    const f = await ws.services.previews.frame({ kind: 'job', jobId, side: 'input' }, 0.5);
    expect(fs.existsSync(fileOf(f.url))).toBe(true);
  }, 180_000);

  it('라이브러리에서 대기열에 추가하면 작업이 생기고 항목에 압축 연결이 보인다', async () => {
    const { items } = ws.services.library.query(QUERY);
    const clip = items.find((i) => i.fileName === 'clip 1.mp4')!;
    const photo = items.find((i) => i.fileName === 'photo.jpg')!;
    const res = ws.services.library.enqueue([clip.id, photo.id]);
    expect(res.added).toHaveLength(1);
    expect(res.skipped.some((s) => s.reason.includes('건너뛰었습니다'))).toBe(true);
    await waitForJob(ws, res.added[0]!.id, (j) => j.status === 'ready');
    const after = ws.services.library.get(clip.id);
    expect(after.compression?.jobId).toBe(res.added[0]!.id);
    expect(ws.services.library.query({ ...QUERY, compressed: 'yes' }).total).toBe(1);
  }, 120_000);
});

describe('메타·태그·중복·변경 감지', () => {
  it('평점·라벨·태그는 재인덱싱 후에도 유지된다', async () => {
    const { items } = ws.services.library.query(QUERY);
    const clip = items.find((i) => i.fileName === 'clip 1.mp4')!;
    ws.services.library.setMeta(clip.id, { rating: 4, label: 'green', note: '좋음' });
    ws.services.library.setTags(clip.id, ['여행', '가족', '여행']);
    ws.services.library.reindex(clip.rootId);
    await indexed();
    const again = ws.services.library.get(clip.id);
    expect(again.rating).toBe(4);
    expect(again.label).toBe('green');
    expect(again.tags).toEqual(['가족', '여행']);
    expect(ws.services.library.listTags().map((t) => t.name)).toEqual(['가족', '여행']);
    expect(ws.services.library.query({ ...QUERY, minRating: 4 }).total).toBe(1);
    expect(ws.services.library.query({ ...QUERY, tags: ['가족'] }).total).toBe(1);
  }, 120_000);

  it('크기·길이가 같은 파일을 중복 후보로 묶고 해시로 확정한다', async () => {
    const groups = ws.services.library.duplicates();
    const g = groups.find((x) => x.items.some((i) => i.fileName === 'dup-a.mp4'));
    expect(g).toBeDefined();
    expect(g!.items.map((i) => i.fileName).sort()).toEqual([
      'clip 1.mp4',
      'dup-a.mp4',
      'dup-b.mp4',
    ]);
    const hashes = await ws.services.library.verifyDuplicates(g!.items.map((i) => i.id));
    expect(new Set(Object.values(hashes)).size).toBe(1);
  }, 120_000);

  it('파일이 바뀌면 다시 분석하고, 사라지면 없음으로 표시하며, 돌아오면 복구된다', async () => {
    const { items } = ws.services.library.query(QUERY);
    const art = items.find((i) => i.fileName === 'art.png')!;
    const root = art.rootId;
    makeImage(art.path, ['-vf', 'scale=100:50']);
    ws.services.library.reindex(root);
    await indexed();
    expect(ws.services.library.get(art.id).width).toBe(100);
    const backup = `${art.path}.bak`;
    fs.renameSync(art.path, backup);
    ws.services.library.reindex(root);
    await indexed();
    expect(ws.services.library.get(art.id).missing).toBe(true);
    expect(ws.services.library.query({ ...QUERY, search: 'art' }).total).toBe(0);
    expect(ws.services.library.query({ ...QUERY, search: 'art', includeMissing: true }).total).toBe(
      1,
    );
    fs.renameSync(backup, art.path);
    ws.services.library.reindex(root);
    await indexed();
    expect(ws.services.library.get(art.id).missing).toBe(false);
  }, 120_000);

  it('캐시를 비우면 썸네일·변환본이 모두 사라지고, 폴더 등록 해제 시 항목이 지워진다', async () => {
    const before = ws.services.library.cacheStats();
    expect(before.thumbCount + before.previewCount).toBeGreaterThan(0);
    const after = ws.services.library.clearCache();
    expect(after.thumbCount).toBe(0);
    expect(after.previewCount).toBe(0);
    const root = ws.services.library.listRoots()[0]!;
    expect(ws.services.library.removeRoot(root.id)).toBe(true);
    expect(ws.services.library.query(QUERY).total).toBe(0);
    // 원본 파일은 그대로 있다
    expect(fs.existsSync(path.join(lib, 'clip 1.mp4'))).toBe(true);
  });
});
