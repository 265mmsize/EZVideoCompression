/** 영상 편집 마무리 기능: HDR 판정, 무손실 합치기 조건, 톤 매핑·음량 맞춤·하드웨어 인코더 인자 */
import { describe, expect, it } from 'vitest';
import {
  conversionWarnings,
  isHdrTransfer,
  supportsTonemap,
  TONEMAP_FILTERS,
} from '../../src/main/services/edit/sourceColor';
import {
  compatibilityReasons,
  losslessArgs,
  losslessProjectBlockers,
  type StreamSignature,
} from '../../src/main/services/edit/losslessMerge';
import { buildRenderPlan, outputArgs } from '../../src/main/services/edit/EditGraphBuilder';
import { newProject } from '../../src/main/services/edit/VideoEditService';
import type { EditClip, EditProject } from '../../src/shared/types/domain';

function clip(over: Partial<EditClip> = {}): EditClip {
  return {
    id: over.id ?? 'c1',
    path: '/v/a.mp4',
    fileName: 'a.mp4',
    sourceDurationSec: 5,
    sourceWidth: 1920,
    sourceHeight: 1080,
    hasAudio: true,
    inSec: 0,
    outSec: 5,
    speed: 1,
    volume: 1,
    mute: false,
    rotate: 0,
    flipH: false,
    flipV: false,
    filters: { brightness: 0, contrast: 1, saturation: 1, sharpen: 0, denoise: 0 },
    stabilize: false,
    transition: { type: 'none', durationSec: 1 },
    texts: [],
    ...over,
  };
}

function project(clips: EditClip[], over: Partial<EditProject> = {}): EditProject {
  return { ...newProject('마무리', '2026-11-04T00:00:00.000Z'), clips, ...over };
}

describe('HDR 판정', () => {
  it('PQ 와 HLG 만 HDR 로 본다', () => {
    expect(isHdrTransfer('smpte2084')).toBe(true);
    expect(isHdrTransfer('arib-std-b67')).toBe(true);
    expect(isHdrTransfer('bt709')).toBe(false);
    expect(isHdrTransfer(null)).toBe(false);
  });

  it('바뀌는 원본만 문장으로 알린다', () => {
    expect(
      conversionWarnings([
        { fileName: 'hdr.mp4', hdr: true, bitDepth: 10 },
        { fileName: 'ten.mov', hdr: false, bitDepth: 10 },
        { fileName: 'sdr.mp4', hdr: false, bitDepth: 8 },
        { fileName: 'unknown.mp4', hdr: false, bitDepth: null },
      ]),
    ).toEqual(['hdr.mp4: HDR → SDR (톤 매핑, 색과 밝기가 달라집니다)', 'ten.mov: 10비트 → 8비트']);
  });

  it('필터 목록에 zscale 과 tonemap 이 모두 있어야 톤 매핑할 수 있다', () => {
    expect(supportsTonemap(' ..C zscale V->V\n .S. tonemap V->V')).toBe(true);
    expect(supportsTonemap(' .S. tonemap V->V')).toBe(false);
  });
});

describe('무손실 합치기 조건', () => {
  it('효과 없이 파일 전체를 쓰는 두 클립이면 막는 것이 없다', () => {
    expect(
      losslessProjectBlockers(project([clip(), clip({ id: 'c2', fileName: 'b.mp4' })])),
    ).toEqual([]);
  });

  it('효과·일부 구간·프로젝트 설정마다 이유를 낸다', () => {
    const reasons = losslessProjectBlockers(
      project(
        [
          clip({
            inSec: 1,
            speed: 2,
            texts: [
              {
                id: 't',
                text: 'x',
                x: 'center',
                y: 'bottom',
                fontSize: 40,
                color: '#fff',
                boxed: false,
                startSec: 0,
                endSec: null,
              },
            ],
          }),
          clip({ id: 'c2', fileName: 'b.mp4', volume: 0.5 }),
        ],
        { canvas: { preset: '720p', fps: 'auto' } },
      ),
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        '캔버스 크기를 지정했습니다 (자동이어야 합니다)',
        'a.mp4: 일부 구간만 씁니다 (파일 전체를 써야 합니다)',
        'a.mp4: 속도를 바꿨습니다',
        'a.mp4: 텍스트가 있습니다',
        'b.mp4: 음량을 바꿨습니다',
      ]),
    );
    expect(losslessProjectBlockers(project([clip()]))).toContain('클립이 두 개 이상이어야 합니다');
  });

  const sig = (over: Partial<StreamSignature> = {}): StreamSignature => ({
    fileName: 'a.mp4',
    ext: 'mp4',
    vcodec: 'h264',
    width: 1920,
    height: 1080,
    pixFmt: 'yuv420p',
    fps: 30,
    acodec: 'aac',
    sampleRate: 48000,
    channels: 2,
    ...over,
  });

  it('형식이 같으면 통과, 다르면 무엇이 다른지 알린다', () => {
    expect(compatibilityReasons([sig(), sig({ fileName: 'b.mp4' })])).toEqual([]);
    expect(
      compatibilityReasons([sig(), sig({ fileName: 'b.mp4', width: 1280, vcodec: 'hevc' })]),
    ).toEqual([
      'b.mp4: 영상 코덱이 첫 파일과 다릅니다 (h264 ↔ hevc)',
      'b.mp4: 가로 크기가 첫 파일과 다릅니다 (1920 ↔ 1280)',
    ]);
    expect(compatibilityReasons([sig({ ext: 'avi' })])[0]).toContain('avi 형식은');
  });

  it('스트림을 복사해 잇는 인자 (음성 없음, mkv 는 faststart 없음)', () => {
    expect(losslessArgs('/t/l.txt', '/o/x.mp4', 'mp4', true)).toEqual([
      '-n',
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      '/t/l.txt',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '/o/x.mp4',
    ]);
    const mkv = losslessArgs('/t/l.txt', '/o/x.mkv', 'mkv', false);
    expect(mkv).not.toContain('0:a:0');
    expect(mkv).not.toContain('+faststart');
  });
});

describe('렌더 계획의 마무리 옵션', () => {
  const OPTS = {
    canvas: { width: 1280, height: 720, fps: 30 },
    textDir: '/tmp/text',
    trfDir: '/tmp/trf',
    fontFile: null,
    nullSink: '/dev/null',
    pathSep: '/' as const,
  };

  it('동의한 HDR 클립에만 톤 매핑을 맞춤 앞에 넣는다', () => {
    const p = project([clip(), clip({ id: 'c2' })]);
    const fc = buildRenderPlan(p, { ...OPTS, tonemapClips: new Set([1]) }).filterComplex;
    const tm = TONEMAP_FILTERS.join(',');
    expect(fc.split(tm)).toHaveLength(2);
    const v1 = fc.slice(fc.indexOf('[1:v]'));
    expect(v1.indexOf(tm)).toBeLessThan(v1.indexOf('scale=1280:720:force_original_aspect_ratio'));
    expect(buildRenderPlan(p, OPTS).filterComplex).not.toContain('tonemap=');
  });

  it('음량 맞춤을 켜면 클립마다 loudnorm 뒤 48kHz 로 되돌린다', () => {
    const p = project([clip()], {
      output: { container: 'mp4', codec: 'h264', crf: 20, preset: 'medium', normalizeAudio: true },
    });
    expect(buildRenderPlan(p, OPTS).filterComplex).toContain(
      'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000',
    );
  });

  it('하드웨어 인코더는 인코더별 품질 값과 8비트 출력, 미리보기는 늘 CPU', () => {
    const out = { container: 'mp4', codec: 'h264', crf: 20, preset: 'medium' } as const;
    const hw = outputArgs('export', out, { name: 'h264_nvenc', family: 'nvenc' });
    expect(hw.slice(0, 2)).toEqual(['-c:v', 'h264_nvenc']);
    expect(hw).toContain('-cq');
    expect(hw).toContain('yuv420p');
    expect(hw).not.toContain('-crf');
    expect(outputArgs('proxy', out, { name: 'h264_nvenc', family: 'nvenc' })[1]).toBe('libx264');
    expect(outputArgs('export', out)[1]).toBe('libx264');
  });
});
