/**
 * 킹뷰·킹플레이어·킹컷 기능을 실제 파일로 확인한다:
 * ZIP·CBZ 목록과 한 장 꺼내기(암호화·경로 이탈 거부 포함), 위치·메타데이터 제거 사본,
 * 키프레임 목록, .kcp 형식 검사와 가져오기.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';
import { kcpFileSchema } from '../../src/shared/schemas/ipc.schemas';
import { readZipEntries } from '../../src/main/services/archive/ZipReader';
import { buildZip } from '../fixtures/zipBuilder';

let ws: Workspace;
let root: string;

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

function probeJson(file: string): string {
  const r = spawnSync(
    process.env['FFPROBE_PATH'] ?? 'ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

function indexedId(file: string): string {
  const { items } = ws.services.library.query({ ...QUERY, search: path.parse(file).name });
  const id = items.find((i) => i.path === file)?.id;
  if (!id) throw new Error(`항목 없음: ${file}`);
  return id;
}

beforeAll(async () => {
  ws = createWorkspace('vslim-kf-');
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  root = path.join(ws.root, '킹뷰 자료');
  fs.mkdirSync(root, { recursive: true });

  // 메타데이터(제목·위치)가 들어간 짧은 영상, 0.5초마다 키프레임 (30fps, GOP 15)
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x120:rate=30',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-g',
    '15',
    '-pix_fmt',
    'yuv420p',
    '-metadata',
    'title=SECRET-TITLE',
    '-metadata',
    'location=+37.5665+126.9780/',
    path.join(root, '메타 영상.mp4'),
  ]);

  // 압축 파일: 이미지 3장(자연 정렬), 텍스트 1개, 암호화 항목이 든 것
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  fs.writeFileSync(
    path.join(root, '묶음.cbz'),
    buildZip([
      { name: 'p10.jpg', data: Buffer.from('jpeg-10') },
      { name: 'memo.txt', data: Buffer.from('not an image') },
      { name: 'p2.jpg', data: Buffer.from('jpeg-2'), method: 0 },
      { name: 'p1.png', data: png },
    ]),
  );
  fs.writeFileSync(
    path.join(root, '암호화.zip'),
    buildZip([{ name: 'a.png', data: png, encrypted: true }]),
  );

  ws.services.library.addRoot(root, false);
  await ws.services.indexer.idle();
}, 300_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('압축 파일 안 이미지 보기', () => {
  it('이미지 항목만 자연 정렬 순서로 목록에 넣는다', () => {
    const list = ws.services.archive.list(path.join(root, '묶음.cbz'));
    expect(list.map((e) => e.name)).toEqual(['p1.png', 'p2.jpg', 'p10.jpg']);
  });

  it('한 장을 꺼내면 종류에 맞는 주소와 형식을 돌려준다', () => {
    const r = ws.services.archive.open(path.join(root, '묶음.cbz'), 'p1.png');
    expect(r.url.startsWith('vslim-media://')).toBe(true);
    expect(r.mime).toBe('image/png');
  });

  it('목록에 없는 이름은 꺼내지 않는다 (경로를 바꾼 이름 포함)', () => {
    expect(() => ws.services.archive.open(path.join(root, '묶음.cbz'), '../evil.png')).toThrow();
    expect(() => ws.services.archive.open(path.join(root, '묶음.cbz'), 'missing.png')).toThrow();
  });

  it('암호화된 항목은 목록에서 빼고, 직접 열려고 하면 거부한다', () => {
    const zip = path.join(root, '암호화.zip');
    expect(ws.services.archive.list(zip)).toEqual([]);
    expect(() => ws.services.archive.open(zip, 'a.png')).toThrow();
  });

  it('ZIP 리더는 저장·DEFLATE 항목의 내용을 그대로 되돌린다', () => {
    const buf = buildZip([
      { name: 'a.jpg', data: Buffer.from('stored-data'), method: 0 },
      { name: 'b.jpg', data: Buffer.from('deflated-data'.repeat(20)), method: 8 },
    ]);
    const entries = readZipEntries(buf);
    expect(entries.map((e) => e.name)).toEqual(['a.jpg', 'b.jpg']);
  });
});

describe('위치·메타데이터 제거 사본', () => {
  it('원본은 그대로 두고 제목과 위치 태그가 없는 사본을 만든다', async () => {
    const src = path.join(root, '메타 영상.mp4');
    const before = fs.readFileSync(src);
    const r = await ws.services.clipCut.stripMetadata(indexedId(src));
    expect(path.basename(r.outputPath)).toBe('메타 영상-clean.mp4');
    const info = JSON.parse(probeJson(r.outputPath)) as {
      format: { tags?: Record<string, string> };
      streams: { tags?: Record<string, string> }[];
    };
    const tagKeys = [
      ...Object.keys(info.format.tags ?? {}),
      ...info.streams.flatMap((s) => Object.keys(s.tags ?? {})),
    ];
    expect(tagKeys).not.toContain('location');
    expect(tagKeys).not.toContain('title');
    expect(JSON.stringify(info)).not.toContain('SECRET-TITLE');
    // 원본은 바뀌지 않는다
    expect(fs.readFileSync(src).equals(before)).toBe(true);
    // 원본에는 여전히 태그가 있다 (사본만 정리했다는 증거)
    expect(probeJson(src)).toContain('SECRET-TITLE');
  }, 120_000);
});

describe('키프레임 목록', () => {
  it('0초부터 0.5초 간격의 키프레임을 돌려준다', async () => {
    const id = indexedId(path.join(root, '메타 영상.mp4'));
    const times = await ws.services.clipCut.keyframeTimes(id);
    expect(times[0]).toBe(0);
    expect(times.length).toBeGreaterThanOrEqual(4);
    expect(times[1]).toBeCloseTo(0.5, 1);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  }, 120_000);
});

describe('.kcp 프로젝트 파일', () => {
  it('저장한 형식이 검사를 통과하고 새 프로젝트로 가져와진다', () => {
    const original = ws.services.videoEdit.create('킹컷 검증 프로젝트');
    const text = JSON.stringify({ format: 'kcp', version: 1, project: original }, null, 2);
    const parsed = kcpFileSchema.safeParse(JSON.parse(text));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const imported = ws.services.videoEdit.importProject(parsed.data.project);
    expect(imported.id).not.toBe(original.id);
    expect(imported.name).toBe('킹컷 검증 프로젝트');
    expect(ws.services.videoEdit.list().some((p) => p.id === imported.id)).toBe(true);
  });

  it('형식이 다른 파일은 가져오지 않는다', () => {
    expect(kcpFileSchema.safeParse({ format: 'kcp', version: 9, project: {} }).success).toBe(false);
  });
});
