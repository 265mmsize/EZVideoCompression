/**
 * 이미지 편집을 실제 FFmpeg 로 확인한다: 열기, 미리보기, 저장(자르기·회전·크기·보정), 원본 불변, 이름 충돌, 라이브러리 반영.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from './helpers';
import { sha256 } from './hash';
import { DEFAULT_OPS } from '../../src/main/services/image/ImageEditService';
import type { ImageEditOps } from '../../src/shared/types/domain';

let ws: Workspace;
let dir: string;

function makeImage(
  name: string,
  extraArgs: string[],
  source = 'testsrc2=size=640x480:rate=1',
): string {
  const out = path.join(dir, name);
  const r = spawnSync(
    process.env['FFMPEG_PATH'] ?? 'ffmpeg',
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-frames:v', '1', ...extraArgs, out],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`이미지 생성 실패: ${r.stderr}`);
  return out;
}

function probeImage(file: string): {
  width: number;
  height: number;
  codec: string;
  pixFmt: string;
} {
  const r = spawnSync(
    process.env['FFPROBE_PATH'] ?? 'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-i', file],
    { encoding: 'utf8' },
  );
  const s = (
    JSON.parse(r.stdout) as {
      streams: { width: number; height: number; codec_name: string; pix_fmt: string }[];
    }
  ).streams[0]!;
  return { width: s.width, height: s.height, codec: s.codec_name, pixFmt: s.pix_fmt };
}

const ops = (patch: Partial<ImageEditOps>): ImageEditOps => ({ ...DEFAULT_OPS, ...patch });

beforeAll(async () => {
  ws = createWorkspace();
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-img-'));
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('열기와 미리보기', () => {
  it('JPEG 를 열면 크기·코덱과 표시용 URL(토큰)을 돌려주고, TIFF 는 변환본으로 표시한다', async () => {
    const jpg = makeImage('사진 원본.jpg', ['-pix_fmt', 'yuvj420p', '-q:v', '3']);
    const info = await ws.services.imageEdit.open(jpg);
    expect(info).toMatchObject({
      width: 640,
      height: 480,
      codec: 'mjpeg',
      hasAlpha: false,
      converted: false,
    });
    expect(info.url).toMatch(/^vslim-media:\/\/file\//);
    expect(info.url).not.toContain('사진');

    const tif = makeImage('scan.tiff', ['-pix_fmt', 'rgb24']);
    const t = await ws.services.imageEdit.open(tif);
    expect(t.codec).toBe('tiff');
    expect(t.converted).toBe(true);
  });

  it('미리보기는 저장 결과 해상도와 함께 maxWidth 이하 축소본을 돌려준다', async () => {
    const jpg = makeImage('preview.jpg', ['-pix_fmt', 'yuvj420p']);
    const p = await ws.services.imageEdit.preview(jpg, ops({ rotate: 90 }), 200);
    expect(p).toMatchObject({ width: 480, height: 640, previewWidth: 200, previewHeight: 267 });
    expect(p.url).toMatch(/^vslim-media:\/\/file\//);
  });
});

describe('저장', () => {
  it('자르기·회전·크기 조정·보정을 적용한 새 파일을 만들고, 원본은 바이트 단위로 같다', async () => {
    const src = makeImage('편집 대상.png', ['-pix_fmt', 'rgb24']);
    const before = sha256(src);
    const res = await ws.services.imageEdit.exportImage({
      path: src,
      ops: ops({
        crop: { x: 40, y: 20, width: 400, height: 300 },
        rotate: 90,
        flipH: true,
        resize: { width: 150, height: 200, filter: 'lanczos' },
        enhance: {
          ...DEFAULT_OPS.enhance,
          sharpen: 0.5,
          denoise: 2,
          contrast: 1.1,
          autoLevel: true,
        },
      }),
      format: 'keep',
      quality: 90,
      target: { kind: 'suffix', suffix: '-edit' },
    });
    expect(res.outputPath).toBe(path.join(dir, '편집 대상-edit.png'));
    expect(res.format).toBe('png');
    expect(res).toMatchObject({ width: 150, height: 200, libraryItemId: null });
    expect(probeImage(res.outputPath)).toMatchObject({ width: 150, height: 200, codec: 'png' });
    expect(sha256(src)).toBe(before);
    expect(res.notes.some((n) => n.includes('EXIF'))).toBe(true);
    // 임시 파일이 남지 않는다
    expect(fs.readdirSync(dir).filter((n) => n.includes('.vslim-tmp-'))).toHaveLength(0);
  });

  it('같은 이름이 있으면 번호를 붙이고 절대 덮어쓰지 않는다', async () => {
    const src = makeImage('dup.jpg', ['-pix_fmt', 'yuvj420p']);
    const a = await ws.services.imageEdit.exportImage({
      path: src,
      ops: DEFAULT_OPS,
      format: 'jpeg',
      quality: 80,
      target: { kind: 'suffix', suffix: '-edit' },
    });
    const hashA = sha256(a.outputPath);
    const b = await ws.services.imageEdit.exportImage({
      path: src,
      ops: ops({ rotate: 180 }),
      format: 'jpeg',
      quality: 80,
      target: { kind: 'suffix', suffix: '-edit' },
    });
    expect(a.outputPath).toBe(path.join(dir, 'dup-edit.jpg'));
    expect(b.outputPath).toBe(path.join(dir, 'dup-edit (2).jpg'));
    expect(sha256(a.outputPath)).toBe(hashA);
  });

  it('지정 경로로 저장할 때도 기존 파일은 번호를 붙여 보존하고, 미세 회전과 PNG 알파를 처리한다', async () => {
    const src = makeImage(
      'alpha.png',
      ['-pix_fmt', 'rgba'],
      'color=c=red@0.5:size=200x100,format=rgba',
    );
    const info = await ws.services.imageEdit.open(src);
    expect(info.hasAlpha).toBe(true);
    const target = path.join(dir, 'out', 'result.png');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'existing');
    const res = await ws.services.imageEdit.exportImage({
      path: src,
      ops: ops({ angle: 45, fillColor: '#00ff00' }),
      format: 'png',
      quality: 100,
      target: { kind: 'path', path: target },
    });
    expect(res.outputPath).toBe(path.join(dir, 'out', 'result (2).png'));
    expect(fs.readFileSync(target, 'utf8')).toBe('existing');
    const p = probeImage(res.outputPath);
    expect(p).toMatchObject({ width: 212, height: 212, codec: 'png', pixFmt: 'rgba' });

    // JPEG 로 저장하면 알파가 사라진다고 알린다
    const jpg = await ws.services.imageEdit.exportImage({
      path: src,
      ops: DEFAULT_OPS,
      format: 'jpeg',
      quality: 95,
      target: { kind: 'suffix', suffix: '-jpg' },
    });
    expect(jpg.notes.some((n) => n.includes('알파'))).toBe(true);
    expect(probeImage(jpg.outputPath).pixFmt).toBe('yuvj444p');
  });

  it('등록된 라이브러리 폴더 안에 저장하면 바로 인덱싱되어 목록에 나타난다', async () => {
    const libDir = path.join(dir, 'lib');
    fs.mkdirSync(libDir);
    const src = makeImage(path.join('lib', 'photo.jpg'), ['-pix_fmt', 'yuvj420p']);
    const root = ws.services.library.addRoot(libDir, false);
    await ws.services.indexer.idle();
    const res = await ws.services.imageEdit.exportImage({
      path: src,
      ops: ops({ resize: { width: 320, height: 240, filter: 'bicubic' } }),
      format: 'keep',
      quality: 85,
      target: { kind: 'suffix', suffix: '-small' },
    });
    expect(res.libraryItemId).not.toBeNull();
    const item = ws.services.library.get(res.libraryItemId!);
    expect(item).toMatchObject({
      rootId: root.id,
      fileName: 'photo-small.jpg',
      kind: 'image',
      width: 320,
      height: 240,
    });
  });

  it('깨진 파일은 IMAGE_EDIT_FAILED 또는 PROBE_FAILED 로 실패하고 결과 파일을 만들지 않는다', async () => {
    const bad = path.join(dir, 'broken.jpg');
    fs.writeFileSync(bad, Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02]));
    await expect(
      ws.services.imageEdit.exportImage({
        path: bad,
        ops: DEFAULT_OPS,
        format: 'jpeg',
        quality: 80,
        target: { kind: 'suffix', suffix: '-x' },
      }),
    ).rejects.toSatisfy((e: unknown) =>
      /IMAGE_EDIT_FAILED|PROBE_FAILED|UNSUPPORTED_INPUT/.test(
        String((e as { code?: string }).code),
      ),
    );
    expect(fs.existsSync(path.join(dir, 'broken-x.jpg'))).toBe(false);
  });
});
