/**
 * 테스트용 합성 영상 생성기.
 *
 * - 모든 픽스처는 FFmpeg 로 실행 시점에 만든다 (바이너리를 저장소에 넣지 않는다).
 * - 합성 영상의 절감률은 일반 영상의 성능 근거가 아니다. 기능·안전성 검증에만 쓴다.
 * - 한글·공백 경로 픽스처는 별도 하위 폴더에 만든다.
 *
 * 사용: node tests/fixtures/generate.ts [출력 디렉터리]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE_NAMES = [
  'h264_sdr.mp4',
  'no_audio.mp4',
  'multi_audio.mkv',
  'subtitle.mkv',
  'rotated.mp4',
  'vfr.mkv',
  'hevc_10bit.mkv',
  'hdr_like.mkv',
  'corrupt.mp4',
  '한글 경로 폴더/테스트 영상 (1).mp4',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

// 모든 실행 경로(vitest, playwright, 직접 실행)가 프로젝트 루트를 cwd 로 가진다는 전제다.
export const DEFAULT_FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/generated');

function ffmpeg(args: string[]): void {
  const exe = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
  const res = spawnSync(exe, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`ffmpeg 픽스처 생성 실패 (${args.join(' ')}):\n${res.stderr}`);
  }
}

const SRC = (w = 640, h = 360, rate = 30, dur = 3): string[] => [
  '-f',
  'lavfi',
  '-i',
  `testsrc2=size=${String(w)}x${String(h)}:rate=${String(rate)}`,
  '-t',
  String(dur),
];
const TONE = (dur = 3): string[] => [
  '-f',
  'lavfi',
  '-i',
  `sine=frequency=440:sample_rate=48000:duration=${String(dur)}`,
];

/** 픽스처 하나를 만든다. 이미 있으면 건너뛴다. */
export function generateFixture(dir: string, name: FixtureName): string {
  const out = path.join(dir, name);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });

  switch (name) {
    case 'h264_sdr.mp4':
      ffmpeg([
        ...SRC(),
        ...TONE(),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
        '-shortest',
        out,
      ]);
      break;
    case 'no_audio.mp4':
      ffmpeg([
        ...SRC(),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
        '-an',
        out,
      ]);
      break;
    case 'multi_audio.mkv':
      ffmpeg([
        ...SRC(),
        ...TONE(),
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=660:sample_rate=48000:duration=3',
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '2:a',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
        '-c:a:0',
        'aac',
        '-c:a:1',
        'ac3',
        '-metadata:s:a:0',
        'language=kor',
        '-metadata:s:a:1',
        'language=eng',
        '-shortest',
        out,
      ]);
      break;
    case 'subtitle.mkv': {
      const srt = path.join(dir, 'subtitle-src.srt');
      fs.writeFileSync(
        srt,
        '1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n\n2\n00:00:01,000 --> 00:00:02,500\nhello\n',
        'utf8',
      );
      ffmpeg([
        ...SRC(),
        ...TONE(),
        '-i',
        srt,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '2:s',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
        '-c:s',
        'srt',
        '-metadata:s:s:0',
        'language=kor',
        '-shortest',
        out,
      ]);
      break;
    }
    case 'rotated.mp4': {
      // 표시 행렬(Display Matrix) 회전은 입력 옵션 -display_rotation 으로만 설정된다. 원본을 만든 뒤 복사 remux 한다.
      const base = path.join(dir, 'rotated-base.mp4');
      ffmpeg([
        ...SRC(),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
        '-an',
        base,
      ]);
      ffmpeg(['-display_rotation', '90', '-i', base, '-c', 'copy', out]);
      fs.rmSync(base, { force: true });
      break;
    }
    case 'vfr.mkv':
      // 입력 타임스탬프를 불규칙하게 만든 뒤 passthrough 로 보존한다 (VFR 유사 픽스처)
      // 프레임 일부를 규칙적으로 버려 타임스탬프 간격을 불규칙하게 만든다 (passthrough 로 보존)
      ffmpeg([
        ...SRC(640, 360, 30, 4),
        '-vf',
        "select='not(eq(mod(n\\,5)\\,2))'",
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
        '-fps_mode',
        'passthrough',
        '-an',
        out,
      ]);
      break;
    case 'hevc_10bit.mkv':
      ffmpeg([
        ...SRC(),
        ...TONE(),
        '-c:v',
        'libx265',
        '-pix_fmt',
        'yuv420p10le',
        '-preset',
        'veryfast',
        '-x265-params',
        'log-level=error',
        '-c:a',
        'aac',
        '-shortest',
        out,
      ]);
      break;
    case 'hdr_like.mkv':
      // HDR 메타데이터(PQ 전달 특성, BT.2020) 를 가진 10비트 영상. 실제 HDR 콘텐츠가 아니라 태그 검증용이다.
      ffmpeg([
        ...SRC(),
        '-c:v',
        'libx265',
        '-pix_fmt',
        'yuv420p10le',
        '-preset',
        'veryfast',
        '-color_primaries',
        'bt2020',
        '-color_trc',
        'smpte2084',
        '-colorspace',
        'bt2020nc',
        '-x265-params',
        'log-level=error:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400',
        '-an',
        out,
      ]);
      break;
    case 'corrupt.mp4': {
      // 손상 입력: MP4 확장자지만 임의의 바이트다. 결정적 결과를 위해 고정 시드 패턴을 쓴다.
      const buf = Buffer.alloc(64 * 1024);
      for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) >>> 24;
      fs.writeFileSync(out, buf);
      break;
    }
    case '한글 경로 폴더/테스트 영상 (1).mp4':
      ffmpeg([
        ...SRC(320, 240, 25, 2),
        ...TONE(2),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
        '-shortest',
        out,
      ]);
      break;
  }
  return out;
}

export function generateAll(dir: string = DEFAULT_FIXTURE_DIR): Record<FixtureName, string> {
  const map = {} as Record<FixtureName, string>;
  for (const n of FIXTURE_NAMES) map[n] = generateFixture(dir, n);
  return map;
}

// 직접 실행된 경우에만 전체 생성
const invokedDirectly = process.argv[1]?.endsWith('generate.ts') === true;
if (invokedDirectly) {
  const target = process.argv[2] ?? DEFAULT_FIXTURE_DIR;
  const map = generateAll(target);
  for (const [k, v] of Object.entries(map)) process.stdout.write(`${k}\t${v}\n`);
}
