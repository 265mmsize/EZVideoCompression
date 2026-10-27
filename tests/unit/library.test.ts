import { describe, expect, it } from 'vitest';
import {
  MediaTokenRegistry,
  mimeOf,
  parseRange,
  planMediaResponse,
  tokenFromUrl,
} from '../../src/main/services/library/MediaTokenRegistry';
import { buildTree } from '../../src/main/repositories/LibraryRepository';
import { kindOfExtension } from '../../src/main/services/library/LibraryIndexer';
import {
  cacheKeyFor,
  scrubTimes,
  thumbTime,
} from '../../src/main/services/library/ThumbnailService';
import { judgeCapability } from '../../src/main/services/library/PreviewService';

describe('Range 요청 해석', () => {
  it('헤더가 없으면 전체(200), 단일 범위는 206, 잘못된 범위는 416', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=200-300', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });

  it('응답 계획에 Content-Range 와 길이가 들어간다', () => {
    const p = planMediaResponse('bytes=10-19', 100, 'video/mp4');
    expect(p.status).toBe(206);
    expect(p.headers['Content-Range']).toBe('bytes 10-19/100');
    expect(p.headers['Content-Length']).toBe('10');
    expect(planMediaResponse(null, 100, 'video/mp4').status).toBe(200);
    expect(planMediaResponse('bytes=999-', 100, 'video/mp4').status).toBe(416);
  });
});

describe('미디어 토큰', () => {
  it('같은 키에는 같은 토큰을, 경로가 바뀌면 새 토큰을 준다. 등록되지 않은 토큰은 해석되지 않는다', () => {
    const r = new MediaTokenRegistry();
    const a = r.issue('item:1', '/a.mp4');
    expect(r.issue('item:1', '/a.mp4')).toBe(a);
    const b = r.issue('item:1', '/b.mp4');
    expect(b).not.toBe(a);
    expect(r.resolve(tokenFromUrl(a) as string)).toBeNull();
    expect(r.resolve(tokenFromUrl(b) as string)?.path).toBe('/b.mp4');
    r.revokePrefix('item:');
    expect(r.resolve(tokenFromUrl(b) as string)).toBeNull();
    expect(tokenFromUrl('vslim-media://file/../etc/passwd')).toBeNull();
    expect(tokenFromUrl('file:///etc/passwd')).toBeNull();
  });

  it('MIME 은 확장자로 정한다', () => {
    expect(mimeOf('/x/a.MP4')).toBe('video/mp4');
    expect(mimeOf('/x/a.tiff')).toBe('image/tiff');
    expect(mimeOf('/x/a.bin')).toBe('application/octet-stream');
  });
});

describe('폴더 트리', () => {
  it('중간 폴더를 만들어 계층을 복원하고 이름순으로 정렬한다', () => {
    const t = buildTree('/lib', [
      { parent_dir: '/lib', n: 2 },
      { parent_dir: '/lib/b/deep', n: 1 },
      { parent_dir: '/lib/a', n: 3 },
    ]);
    expect(t.itemCount).toBe(2);
    expect(t.children.map((c) => c.name)).toEqual(['a', 'b']);
    expect(t.children[1]?.children[0]?.name).toBe('deep');
    expect(t.children[1]?.itemCount).toBe(0);
  });
});

describe('종류 판정과 썸네일 키', () => {
  it('확장자로 영상·이미지를 나누고 HEIC 는 제외한다', () => {
    expect(kindOfExtension('.MP4')).toBe('video');
    expect(kindOfExtension('.tiff')).toBe('image');
    expect(kindOfExtension('.heic')).toBe('other');
  });

  it('스크럽 시점은 길이에 따라 줄고 범위를 넘지 않는다', () => {
    expect(scrubTimes(3)).toHaveLength(3);
    expect(scrubTimes(100)).toHaveLength(10);
    expect(Math.max(...scrubTimes(100))).toBeLessThan(100);
    expect(scrubTimes(null)).toEqual([]);
    expect(thumbTime(1)).toBe(0);
    expect(thumbTime(600)).toBe(30);
  });

  it('캐시 키는 경로·크기·수정시간·변형에 따라 달라진다', () => {
    const base = { path: '/a.mp4', sizeBytes: 1, mtimeMs: 1000 };
    expect(cacheKeyFor(base, 'thumb')).toBe(cacheKeyFor({ ...base }, 'thumb'));
    expect(cacheKeyFor(base, 'thumb')).not.toBe(cacheKeyFor({ ...base, mtimeMs: 2000 }, 'thumb'));
    expect(cacheKeyFor(base, 'thumb')).not.toBe(cacheKeyFor(base, 'frame-1.0'));
  });
});

describe('직접 재생 판정', () => {
  const v = (
    videoCodec: string,
    p = '/a.mp4',
    formatName = 'mov,mp4,m4a,3gp,3g2,mj2',
    audioCodec: string | null = 'aac',
  ) => judgeCapability({ mediaKind: 'video', path: p, videoCodec, audioCodec, formatName });

  it('H.264 MP4 는 직접 재생, HEVC 는 아님, MKV 는 보장하지 않음', () => {
    expect(v('h264').direct).toBe(true);
    expect(v('hevc').direct).toBe(false);
    expect(v('h264', '/a.mkv', 'matroska,webm').direct).toBe(false);
    expect(v('vp9', '/a.webm', 'matroska,webm').direct).toBe(true);
  });

  it('AC-3 음성은 재생 불가로 표시하되 영상은 직접 재생한다', () => {
    const c = v('h264', '/a.mp4', 'mov,mp4', 'ac3');
    expect(c.direct).toBe(true);
    expect(c.audioPlayable).toBe(false);
    expect(c.reason).toContain('소리 없이');
  });

  it('TIFF 이미지는 변환본 표시가 필요하다', () => {
    const c = judgeCapability({
      mediaKind: 'image',
      path: '/a.tiff',
      videoCodec: 'tiff',
      audioCodec: null,
      formatName: 'image2',
    });
    expect(c.direct).toBe(false);
    expect(
      judgeCapability({
        mediaKind: 'image',
        path: '/a.png',
        videoCodec: 'png',
        audioCodec: null,
        formatName: 'png_pipe',
      }).direct,
    ).toBe(true);
  });
});
