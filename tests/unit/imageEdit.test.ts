/**
 * 이미지 편집: 결과 크기 계산, 자르기 경계, 필터 체인, 형식·품질 인자 (순수 로직)
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPS,
  buildImageFilterChain,
  clampCrop,
  ffColor,
  formatArgs,
  isIdentity,
  predictOutputSize,
  resolveFormat,
} from '../../src/main/services/image/ImageEditService';
import type { ImageEditOps } from '../../src/shared/types/domain';

const SRC = { width: 1000, height: 600 };
const ops = (patch: Partial<ImageEditOps>): ImageEditOps => ({ ...DEFAULT_OPS, ...patch });

describe('결과 크기 계산', () => {
  it('자르기 → 90° 회전 → 크기 조정 순서로 계산한다', () => {
    expect(predictOutputSize(SRC, DEFAULT_OPS)).toEqual(SRC);
    expect(
      predictOutputSize(SRC, ops({ crop: { x: 100, y: 50, width: 400, height: 300 } })),
    ).toEqual({ width: 400, height: 300 });
    expect(predictOutputSize(SRC, ops({ rotate: 90 }))).toEqual({ width: 600, height: 1000 });
    expect(predictOutputSize(SRC, ops({ rotate: 180 }))).toEqual(SRC);
    expect(
      predictOutputSize(
        SRC,
        ops({
          crop: { x: 0, y: 0, width: 400, height: 300 },
          rotate: 270,
          resize: { width: 150, height: 200, filter: 'lanczos' },
        }),
      ),
    ).toEqual({ width: 150, height: 200 });
  });

  it('미세 회전은 전체가 들어가도록 캔버스를 키운다 (rotw/roth 와 같은 식)', () => {
    const r = predictOutputSize({ width: 100, height: 100 }, ops({ angle: 45 }));
    // 100 × 100 을 45° 돌리면 대각선 길이 ≈ 141.42 → FFmpeg 와 같은 반올림 141
    expect(r).toEqual({ width: 141, height: 141 });
    const r2 = predictOutputSize({ width: 200, height: 100 }, ops({ angle: -30 }));
    expect(r2.width).toBeGreaterThan(0);
  });

  it('자르기 영역이 원본을 넘으면 안쪽으로 맞춘다', () => {
    expect(clampCrop({ x: -10, y: 550, width: 2000, height: 100 }, SRC)).toEqual({
      x: 0,
      y: 550,
      width: 1000,
      height: 50,
    });
    expect(clampCrop({ x: 999, y: 599, width: 5, height: 5 }, SRC)).toEqual({
      x: 999,
      y: 599,
      width: 1,
      height: 1,
    });
  });
});

describe('필터 체인', () => {
  it('기본값이면 빈 체인이고 identity 로 판정한다', () => {
    expect(buildImageFilterChain(SRC, DEFAULT_OPS)).toEqual([]);
    expect(isIdentity(DEFAULT_OPS)).toBe(true);
    expect(isIdentity(ops({ flipH: true }))).toBe(false);
    expect(isIdentity(ops({ enhance: { ...DEFAULT_OPS.enhance, sharpen: 0.1 } }))).toBe(false);
  });

  it('연산 순서가 자르기 → 회전·뒤집기 → 미세 회전 → 크기 → 보정이다', () => {
    const chain = buildImageFilterChain(
      SRC,
      ops({
        crop: { x: 10, y: 20, width: 300, height: 200 },
        rotate: 90,
        flipH: true,
        angle: 10,
        fillColor: '#ff8800',
        resize: { width: 150, height: 100, filter: 'bicubic' },
        enhance: {
          sharpen: 0.8,
          denoise: 3,
          brightness: 0.1,
          contrast: 1.2,
          saturation: 1,
          gamma: 1,
          autoLevel: true,
        },
      }),
    );
    expect(chain[0]).toBe('crop=300:200:10:20');
    expect(chain[1]).toBe('transpose=1');
    expect(chain[2]).toBe('hflip');
    expect(chain[3]).toMatch(
      /^rotate=0\.174533:ow=rotw\(0\.174533\):oh=roth\(0\.174533\):c=0xFF8800$/,
    );
    expect(chain[4]).toBe('scale=150:100:flags=bicubic');
    expect(chain[5]).toBe('normalize=smoothing=0');
    expect(chain[6]).toBe('eq=brightness=0.100:contrast=1.200:saturation=1.000:gamma=1.000');
    expect(chain[7]).toBe('hqdn3d=3.00:3.00:0:0');
    expect(chain[8]).toBe('unsharp=5:5:0.80:5:5:0');
    expect(chain).toHaveLength(9);
  });

  it('180° 는 transpose 두 번, 270° 는 transpose=2', () => {
    expect(buildImageFilterChain(SRC, ops({ rotate: 180 }))).toEqual([
      'transpose=1',
      'transpose=1',
    ]);
    expect(buildImageFilterChain(SRC, ops({ rotate: 270 }))).toEqual(['transpose=2']);
    expect(ffColor('#0a0B0c')).toBe('0x0A0B0C');
  });
});

describe('저장 형식', () => {
  it("'keep' 은 원본 코덱을 따르고 모르는 형식은 PNG 로 간다", () => {
    expect(resolveFormat('keep', 'mjpeg')).toBe('jpeg');
    expect(resolveFormat('keep', 'webp')).toBe('webp');
    expect(resolveFormat('keep', 'tiff')).toBe('png');
    expect(resolveFormat('png', 'mjpeg')).toBe('png');
  });

  it('JPEG 품질은 -q:v 2(최고)~31 로, 90 이상은 4:4:4 를 쓴다', () => {
    expect(formatArgs('jpeg', 100, false)).toEqual([
      '-c:v',
      'mjpeg',
      '-q:v',
      '2',
      '-pix_fmt',
      'yuvj444p',
    ]);
    expect(formatArgs('jpeg', 1, false)).toEqual([
      '-c:v',
      'mjpeg',
      '-q:v',
      '31',
      '-pix_fmt',
      'yuvj420p',
    ]);
    expect(formatArgs('jpeg', 75, true)[5]).toBe('yuvj420p');
  });

  it('PNG 는 알파가 있으면 rgba, WebP 는 품질과 알파 포맷을 넘긴다', () => {
    expect(formatArgs('png', 50, true)).toContain('rgba');
    expect(formatArgs('png', 50, false)).toContain('rgb24');
    const webp = formatArgs('webp', 80, true);
    expect(webp.slice(0, 4)).toEqual(['-c:v', 'libwebp', '-quality', '80']);
    expect(webp).toContain('yuva420p');
  });
});
