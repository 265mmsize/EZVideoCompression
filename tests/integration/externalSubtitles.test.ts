/**
 * 외부 자막 파일을 실제 FFmpeg 로 결과에 합치는 통합 테스트.
 * 영상 옆에 UTF-8 자막과 CP949 자막을 두고 MKV·MP4·원본 유지 모드에서 트랙이 들어가는지 ffprobe 로 확인한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFixture, createWorkspace, waitForJob, type Workspace } from './helpers';
import { sha256 } from './hash';

let ws: Workspace;

const SRT_UTF8 =
  '1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n\n2\n00:00:01,000 --> 00:00:02,000\n둘째 줄\n';
// "1\n00:00:00,000 --> 00:00:01,000\n안녕\n" 을 CP949 로 적은 바이트
const SRT_CP949 = Buffer.concat([
  Buffer.from('1\n00:00:00,000 --> 00:00:01,000\n', 'latin1'),
  Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0x0a]),
]);

interface ProbedStream {
  codec_type: string;
  codec_name: string;
  tags?: Record<string, string>;
}

function probeStreams(file: string): ProbedStream[] {
  const r = spawnSync(
    process.env['FFPROBE_PATH'] ?? 'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-i', file],
    { encoding: 'utf8' },
  );
  return (JSON.parse(r.stdout) as { streams: ProbedStream[] }).streams;
}

/** 영상 옆에 자막 두 개(UTF-8 한국어, CP949 영어 태그)를 만든다 */
function placeSubtitles(video: string): { ko: string; en: string } {
  const base = video.slice(0, -path.extname(video).length);
  const ko = `${base}.ko.srt`;
  const en = `${base}.en.srt`;
  fs.writeFileSync(ko, SRT_UTF8, 'utf8');
  fs.writeFileSync(en, SRT_CP949);
  return { ko, en };
}

beforeAll(async () => {
  ws = createWorkspace();
  const status = await ws.services.refreshTools();
  if (!status.ready) throw new Error(`FFmpeg 필요: ${status.ffmpeg.error ?? ''}`);
  // 원본 유지 모드는 결과가 원본보다 커질 수 있으므로, 결과 파일을 검사하려면 보관해야 한다
  ws.services.settings.update({ keepLargerResults: true });
}, 180_000);

afterAll(async () => {
  await ws.cleanup();
});

describe('외부 자막 감지와 포함', () => {
  it('MKV 출력에 내장 자막 1개 + 외부 자막 2개가 언어 태그와 함께 들어가고, 자막 원본은 변하지 않는다', async () => {
    const input = copyFixture(ws, 'subtitle.mkv');
    const subs = placeSubtitles(input);
    const hashes = { ko: sha256(subs.ko), en: sha256(subs.en) };

    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    const ready = await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    expect(ready.status).toBe('ready');
    const detected = ready.analysis?.externalSubtitles ?? [];
    expect(
      detected.map((d) => [
        d.fileName.endsWith('.ko.srt') ? 'ko' : 'en',
        d.encoding,
        d.language,
        d.action,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['ko', 'utf-8', 'kor', 'transcode'], // 기본 컨테이너 MP4
        ['en', 'cp949', 'eng', 'transcode'],
      ]),
    );

    ws.services.queue.updateSettings(id, { container: 'mkv' });
    expect(ws.services.queue.get(id).analysis?.externalSubtitles?.map((d) => d.action)).toEqual([
      'copy',
      'copy',
    ]);
    ws.services.queue.start([id]);
    const done = await waitForJob(ws, id, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );
    expect(done.errorDetail).toBeNull();
    expect(done.validation?.checks.find((c) => c.id === 'tracks-subtitle')?.passed).toBe(true);

    const out = done.outputPath ?? ws.services.queue.get(id).outputPath;
    expect(out).toBeTruthy();
    const subStreams = probeStreams(out!).filter((s) => s.codec_type === 'subtitle');
    expect(subStreams).toHaveLength(3);
    expect(subStreams.map((s) => s.tags?.['language'])).toEqual(['kor', 'eng', 'kor']);
    expect(subStreams[1]?.tags?.['title']).toMatch(/\.en\.srt$/);
    // CP949 자막이 UTF-8 로 들어갔는지: 결과에서 자막을 뽑아 한글이 그대로인지 본다
    const dump = spawnSync(
      process.env['FFMPEG_PATH'] ?? 'ffmpeg',
      ['-v', 'error', '-i', out!, '-map', '0:s:2', '-f', 'srt', '-'],
      { encoding: 'utf8' },
    );
    expect(dump.stdout).toContain('안녕');

    expect(sha256(subs.ko)).toBe(hashes.ko);
    expect(sha256(subs.en)).toBe(hashes.en);
  }, 300_000);

  it('MP4 출력에서는 mov_text 로 변환되고, 원본 유지 모드에서도 외부 자막이 합쳐진다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    placeSubtitles(input);
    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    ws.services.queue.updateSettings(id, { mode: 'copy', container: 'mp4' });
    ws.services.queue.start([id]);
    const done = await waitForJob(ws, id, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );
    expect(done.errorDetail).toBeNull();
    const out = done.outputPath;
    expect(out).toBeTruthy();
    const subStreams = probeStreams(out!).filter((s) => s.codec_type === 'subtitle');
    expect(subStreams.map((s) => s.codec_name)).toEqual(['mov_text', 'mov_text']);
  }, 300_000);

  it('목표 용량(2-pass) 모드에서도 외부 자막이 MKV 에 들어간다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    placeSubtitles(input);
    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    ws.services.queue.updateSettings(id, { mode: 'target', targetMiB: 1, container: 'mkv' });
    ws.services.queue.start([id]);
    const done = await waitForJob(ws, id, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );
    expect(done.errorDetail).toBeNull();
    const subStreams = probeStreams(done.outputPath!).filter((s) => s.codec_type === 'subtitle');
    expect(subStreams.map((s) => s.codec_name)).toEqual(['subrip', 'subrip']);
  }, 300_000);

  it('포함을 끄면 자막 트랙이 들어가지 않는다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    placeSubtitles(input);
    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    ws.services.queue.updateSettings(id, { mode: 'copy', externalSubtitles: false });
    const view = ws.services.queue.get(id);
    expect(view.analysis?.externalSubtitles?.every((d) => d.action === 'exclude')).toBe(true);
    ws.services.queue.start([id]);
    const done = await waitForJob(ws, id, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );
    expect(done.errorDetail).toBeNull();
    const subStreams = probeStreams(done.outputPath!).filter((s) => s.codec_type === 'subtitle');
    expect(subStreams).toHaveLength(0);
  }, 300_000);

  it('분석 뒤 자막 파일이 바뀌면 INPUT_CHANGED 로 중단하고 결과를 만들지 않는다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    const subs = placeSubtitles(input);
    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    ws.services.queue.updateSettings(id, { mode: 'copy' });
    fs.writeFileSync(subs.ko, SRT_UTF8 + '\n3\n00:00:02,000 --> 00:00:03,000\n추가\n', 'utf8');
    ws.services.queue.start([id]);
    const done = await waitForJob(ws, id, (j) =>
      ['completed', 'no_savings', 'failed'].includes(j.status),
    );
    expect(done.status).toBe('failed');
    expect(done.errorCode).toBe('INPUT_CHANGED');
    expect(done.errorDetail).toContain('.ko.srt');
    const stem = path.basename(input, '.mp4');
    expect(
      fs.readdirSync(path.dirname(input)).filter((n) => n.startsWith(stem) && n.includes('-slim')),
    ).toHaveLength(0);
  }, 300_000);

  it('읽을 수 없는 자막(잘못된 내용)은 사유와 함께 제외하고 작업은 계속된다', async () => {
    const input = copyFixture(ws, 'h264_sdr.mp4');
    const base = input.slice(0, -4);
    fs.writeFileSync(`${base}.srt`, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]));
    const id = ws.services.queue.addPaths([input], false).added[0]!.id;
    const ready = await waitForJob(ws, id, (j) => j.status === 'ready' || j.status === 'failed');
    expect(ready.status).toBe('ready');
    const d = ready.analysis?.externalSubtitles?.[0];
    expect(d?.action).toBe('exclude');
    expect(ready.analysis?.limitations.some((l) => l.code === 'EXTERNAL_SUBTITLE_EXCLUDED')).toBe(
      true,
    );
  }, 120_000);
});
