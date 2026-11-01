/**
 * 킹플레이어·킹컷·킹뷰 기능을 실제 FFmpeg 로 확인한다:
 * 스마트 컷, 구간 합치기, 프레임 저장, 자막 읽기, 이미지 한 픽셀 읽기.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';
import { loadSubtitlesFor } from '../../src/main/services/library/LibrarySubtitles';

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

function ff(args: string[]): void {
  const r = spawnSync(process.env['FFMPEG_PATH'] ?? 'ffmpeg', ['-v', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
}

function durationOf(file: string): number {
  const r = spawnSync(
    process.env['FFPROBE_PATH'] ?? 'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return Number(r.stdout.trim());
}

function indexedItem(file: string): string {
  // 이름 검색은 "-cut" 같은 결과 파일도 걸리므로 경로가 정확히 같은 항목을 고른다
  const { items } = ws.services.library.query({ ...QUERY, search: path.parse(file).name });
  const id = items.find((i) => i.path === file)?.id;
  if (!id) throw new Error(`항목 없음: ${file}`);
  return id;
}

beforeAll(async () => {
  ws = createWorkspace('vslim-pf-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  lib = path.join(ws.root, '기능 라이브러리');
  fs.mkdirSync(lib, { recursive: true });
  // 0.5초마다 키프레임이 있는 6초 영상 (스마트 컷 검증용)
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '6',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-g',
    '15',
    '-keyint_min',
    '15',
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    path.join(lib, '키프레임 영상.mp4'),
  ]);
  ws.services.library.addRoot(lib, false);
  await ws.services.indexer.idle();
}, 300_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('킹컷 스마트 컷과 구간 합치기', () => {
  it('스마트 컷: 시작 키프레임 전까지만 재인코딩하고 요청 길이를 지킨다', async () => {
    const src = path.join(lib, '키프레임 영상.mp4');
    const before = fs.readFileSync(src).length;
    const id = indexedItem(src);
    const res = await ws.services.clipCut.cut(id, 0.3, 3.7, 'smart');
    expect(res.mode).toBe('smart');
    expect(res.notes.join(' ')).toContain('스마트 컷');
    expect(Math.abs(res.durationSec - 3.4)).toBeLessThan(0.3);
    expect(durationOf(res.outputPath)).toBeGreaterThan(3.1);
    expect(fs.readFileSync(src).length).toBe(before);
  }, 300_000);

  it('구간 목록을 순서대로 한 파일로 합친다', async () => {
    const src = path.join(lib, '키프레임 영상.mp4');
    const id = indexedItem(src);
    const res = await ws.services.clipCut.cutRanges(
      id,
      [
        { startSec: 0.5, endSec: 1.5 },
        { startSec: 3, endSec: 4 },
      ],
      'fast',
    );
    expect(res.notes.join(' ')).toContain('하나로 합쳤습니다');
    // 두 구간은 각각 1초 이상이므로 합계는 2초 근처다 (키프레임 시작 때문에 조금 길 수 있다)
    expect(res.durationSec).toBeGreaterThan(1.8);
    expect(res.durationSec).toBeLessThan(2.8);
    expect(fs.readdirSync(lib).filter((n) => n.includes('.vslim-tmp-'))).toHaveLength(0);
  }, 300_000);

  it('정확 모드 구간 목록도 합쳐지고, 구간 목록의 잘못된 값은 거부한다', async () => {
    const src = path.join(lib, '키프레임 영상.mp4');
    const id = indexedItem(src);
    const res = await ws.services.clipCut.cutRanges(
      id,
      [
        { startSec: 1, endSec: 2 },
        { startSec: 2.5, endSec: 3.5 },
      ],
      'exact',
    );
    expect(res.durationSec).toBeGreaterThan(1.9);
    await expect(ws.services.clipCut.cutRanges(id, [], 'fast')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  }, 300_000);
});

describe('킹플레이어 스크린샷과 자막', () => {
  it('지정 시점의 프레임을 원본 해상도 PNG 로 저장한다', async () => {
    const src = path.join(lib, '키프레임 영상.mp4');
    const id = indexedItem(src);
    const res = await ws.services.clipCut.saveFrame(id, 1.2);
    expect(res.outputPath.endsWith('.png')).toBe(true);
    expect(res.width).toBe(320);
    expect(res.height).toBe(240);
    expect(fs.existsSync(res.outputPath)).toBe(true);
    await expect(ws.services.clipCut.saveFrame(id, 99)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  }, 120_000);

  it('같은 이름의 자막 파일을 UTF-8 로 읽어 화면용 텍스트로 돌려준다', () => {
    const video = path.join(lib, '키프레임 영상.mp4');
    fs.writeFileSync(
      path.join(lib, '키프레임 영상.srt'),
      '1\n00:00:01,000 --> 00:00:02,000\n안녕하세요\n',
      'utf8',
    );
    const subs = loadSubtitlesFor(video);
    const srt = subs.find((s) => s.fileName === '키프레임 영상.srt');
    expect(srt).toBeDefined();
    expect(srt?.format).toBe('srt');
    expect(srt?.text).toContain('안녕하세요');
  });
});

describe('킹뷰 컬러 피커', () => {
  it('원본 이미지의 한 픽셀 RGB 를 정확히 읽는다', async () => {
    const png = path.join(lib, '빨강.png');
    ff(['-f', 'lavfi', '-i', 'color=c=red:size=100x80', '-frames:v', '1', png]);
    const rgb = await ws.services.imageEdit.pixel(png, 5, 5);
    // 색 공간 변환 때문에 순색이 1~2 정도 흔들릴 수 있다
    expect(rgb.r).toBeGreaterThan(249);
    expect(rgb.g).toBeLessThan(6);
    expect(rgb.b).toBeLessThan(6);
    await expect(ws.services.imageEdit.pixel(png, 500, 500)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  }, 120_000);
});
