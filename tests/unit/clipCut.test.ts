/**
 * 라이브러리 구간 자르기 인자와 컨테이너 결정 (순수 로직)
 */
import { describe, expect, it } from 'vitest';
import { buildCutArgs, cutContainerFor } from '../../src/main/services/library/ClipCutService';
import { outputArgs } from '../../src/main/services/edit/EditGraphBuilder';

describe('구간 자르기 인자', () => {
  it('빠름 모드는 입력 탐색으로 자르고 스트림을 복사한다', () => {
    const args = buildCutArgs('/v/a.mp4', '/v/a-cut.tmp.mp4', 12.5, 7.25, 'fast');
    const ss = args.indexOf('-ss');
    const input = args.indexOf('-i');
    expect(ss).toBeGreaterThan(0);
    expect(ss).toBeLessThan(input);
    expect(args[ss + 1]).toBe('12.500');
    expect(args).toEqual(
      expect.arrayContaining(['-c', 'copy', '-map', '0', '-avoid_negative_ts', 'make_zero']),
    );
    expect(args).not.toContain('libx264');
    expect(args[args.length - 1]).toBe('/v/a-cut.tmp.mp4');
  });

  it('정확 모드는 재인코딩하고 음성이 없으면 음성 매핑을 건너뛴다', () => {
    const args = buildCutArgs('/v/a.mp4', '/v/out.mp4', 1, 2, 'exact');
    expect(args).toEqual(
      expect.arrayContaining(['-c:v', 'libx264', '-crf', '18', '-map', '0:v:0', '-map', '0:a?']),
    );
    expect(args.indexOf('-i')).toBeLessThan(args.indexOf('-ss'));
  });

  it('MP4·MOV·MKV 는 같은 컨테이너, 그 밖은 MKV 로 만든다', () => {
    expect(cutContainerFor('/v/a.MOV')).toBe('mov');
    expect(cutContainerFor('/v/a.mkv')).toBe('mkv');
    expect(cutContainerFor('/v/a.avi')).toBe('mkv');
    expect(cutContainerFor('/v/a.webm')).toBe('mkv');
  });
});

describe('음성 제외 내보내기 인자', () => {
  it('noAudio 이면 음성 인코더 인자 없이 -an 만 넣는다', () => {
    const out = outputArgs('export', {
      container: 'mp4',
      codec: 'h264',
      crf: 20,
      preset: 'medium',
      noAudio: true,
    });
    expect(out).toContain('-an');
    expect(out).not.toContain('aac');
    expect(out).not.toContain('-b:a');
  });

  it('noAudio 가 없으면(이전 프로젝트) 기존처럼 AAC 를 쓴다', () => {
    const out = outputArgs('export', {
      container: 'mp4',
      codec: 'h264',
      crf: 20,
      preset: 'medium',
    });
    expect(out).toEqual(expect.arrayContaining(['-c:a', 'aac', '-b:a', '192k']));
    expect(out).not.toContain('-an');
  });
});
