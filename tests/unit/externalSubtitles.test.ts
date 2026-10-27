/**
 * 외부 자막: 후보 선택, 언어 태그, 인코딩 판정, 컨테이너별 결정, FFmpeg 인자 (순수 로직)
 */
import { describe, expect, it } from 'vitest';
import {
  decideExternalSubtitles,
  decodeSubtitle,
  languageFromTags,
  matchSubtitleCandidates,
  sniffEncoding,
} from '../../src/main/services/ExternalSubtitleService';
import { trackCodecArgs } from '../../src/main/services/CompressionPolicyService';
import type { DetectedSubtitle, ProbeResult } from '../../src/shared/types/domain';

function detected(over: Partial<DetectedSubtitle> = {}): DetectedSubtitle {
  return {
    path: '/v/영상.ko.srt',
    fileName: '영상.ko.srt',
    sizeBytes: 100,
    mtimeMs: 1,
    format: 'srt',
    encoding: 'utf-8',
    language: 'kor',
    error: null,
    ...over,
  };
}

describe('자막 후보 선택', () => {
  it('같은 기본 이름 + 선택적 태그 + 자막 확장자만 고르고, 태그 없는 파일을 앞에 둔다', () => {
    const names = [
      '영상.ko.srt',
      '영상.srt',
      '영상.en.forced.ass',
      '영상.vtt',
      '영상2.srt', // 다른 영상
      '영상.srt.bak', // 자막 확장자가 아님
      '영상.sub', // 이미지 자막 형식은 대상 아님
      '다른.srt',
      '영상..srt', // 빈 태그
      '영상.mp4',
    ];
    const got = matchSubtitleCandidates('영상.mp4', names, '/v').map((c) => c.fileName);
    expect(got).toEqual(['영상.srt', '영상.vtt', '영상.ko.srt', '영상.en.forced.ass']);
  });

  it('대소문자가 달라도 같은 이름으로 보고, 10개까지만 고른다', () => {
    const names = ['MOVIE.SRT', ...Array.from({ length: 12 }, (_, i) => `movie.t${String(i)}.srt`)];
    const got = matchSubtitleCandidates('movie.mkv', names, '/v');
    expect(got[0]?.fileName).toBe('MOVIE.SRT');
    expect(got).toHaveLength(10);
  });

  it('언어 태그는 2글자 표를 거치거나 3글자 알파벳을 그대로 쓴다', () => {
    expect(languageFromTags(['ko'])).toBe('kor');
    expect(languageFromTags(['forced', 'EN'])).toBe('eng');
    expect(languageFromTags(['jpn'])).toBe('jpn');
    expect(languageFromTags(['forced'])).toBeNull();
    expect(languageFromTags([])).toBeNull();
  });
});

describe('문자 인코딩 판정', () => {
  const cp949Hello = new Uint8Array([0xbe, 0xc8, 0xb3, 0xe7]); // "안녕" (CP949)

  it('UTF-8 (BOM 유무), UTF-16 BOM, CP949 를 구분한다', () => {
    expect(sniffEncoding(new TextEncoder().encode('안녕\n'))).toBe('utf-8');
    expect(sniffEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf-8');
    expect(sniffEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe('utf-16le');
    expect(sniffEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x41]))).toBe('utf-16be');
    expect(sniffEncoding(cp949Hello)).toBe('cp949');
    // BOM 없는 UTF-16LE/BE ("1\n0" 을 2바이트씩)
    expect(sniffEncoding(new Uint8Array([0x31, 0x00, 0x0a, 0x00, 0x30, 0x00]))).toBe('utf-16le');
    expect(sniffEncoding(new Uint8Array([0x00, 0x31, 0x00, 0x0a, 0x00, 0x30]))).toBe('utf-16be');
    // 임의 바이트는 불명
    expect(sniffEncoding(new Uint8Array([0xff, 0xfd, 0x80, 0x81, 0xc0]))).toBe('unknown');
  });

  it('CP949 와 UTF-16 을 UTF-8 문자열로 바꾸고 BOM 을 뗀다', () => {
    expect(decodeSubtitle(cp949Hello, 'cp949')).toBe('안녕');
    expect(decodeSubtitle(new Uint8Array([0xff, 0xfe, 0x41, 0x00]), 'utf-16le')).toBe('A');
    expect(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), 'utf-8')).toBe('A');
    expect(() => decodeSubtitle(cp949Hello, 'unknown')).toThrow();
  });
});

describe('컨테이너별 결정', () => {
  it('MKV: SRT·ASS 복사, WebVTT 는 SRT 변환', () => {
    const got = decideExternalSubtitles(
      [detected(), detected({ format: 'ass' }), detected({ format: 'webvtt' })],
      { container: 'mkv', externalSubtitles: true },
    );
    expect(got.map((d) => d.action)).toEqual(['copy', 'copy', 'transcode']);
  });

  it('MP4: 모두 mov_text 변환이며 ASS 는 스타일 손실을 알린다', () => {
    const got = decideExternalSubtitles([detected(), detected({ format: 'ass' })], {
      container: 'mp4',
      externalSubtitles: true,
    });
    expect(got.map((d) => d.action)).toEqual(['transcode', 'transcode']);
    expect(got[1]?.reason).toContain('스타일');
  });

  it('설정 끔, 읽기 실패, 인코딩 불명은 사유와 함께 제외한다', () => {
    expect(
      decideExternalSubtitles([detected()], { container: 'mkv', externalSubtitles: false })[0]
        ?.action,
    ).toBe('exclude');
    const bad = decideExternalSubtitles(
      [detected({ format: null, error: 'ffprobe 실패' }), detected({ encoding: 'unknown' })],
      { container: 'mkv', externalSubtitles: true },
    );
    expect(bad.map((d) => d.action)).toEqual(['exclude', 'exclude']);
    expect(bad[0]?.reason).toContain('ffprobe 실패');
    expect(bad[1]?.reason).toContain('인코딩');
  });
});

describe('FFmpeg 인자', () => {
  const probe = { streams: [] } as unknown as ProbeResult;

  it('외부 자막은 내장 자막 뒤 순번을 받고 언어·제목 메타데이터를 붙인다', () => {
    const internal = [
      {
        streamIndex: 2,
        kind: 'subtitle' as const,
        codecName: 'subrip',
        label: '자막 #2',
        action: 'copy' as const,
        reason: '',
      },
    ];
    const args = trackCodecArgs(internal, 'mkv', probe, [
      { ...detected(), action: 'copy', reason: '' },
      {
        ...detected({ fileName: '영상.vtt', format: 'webvtt', language: null }),
        action: 'transcode',
        reason: '',
      },
      { ...detected({ fileName: 'x.srt' }), action: 'exclude', reason: '' },
    ]);
    expect(args).toEqual([
      '-c:s:0',
      'copy',
      '-c:s:1',
      'copy',
      '-metadata:s:s:1',
      'language=kor',
      '-metadata:s:s:1',
      'title=영상.ko.srt',
      '-c:s:2',
      'srt',
      '-metadata:s:s:2',
      'title=영상.vtt',
    ]);
  });

  it('MP4 에서는 외부 자막을 mov_text 로 변환한다', () => {
    const args = trackCodecArgs([], 'mp4', probe, [
      { ...detected(), action: 'transcode', reason: '' },
    ]);
    expect(args.slice(0, 2)).toEqual(['-c:s:0', 'mov_text']);
  });
});
