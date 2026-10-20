import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  finalizeFile,
  isSamePath,
  resolveFinalPath,
  tempOutputPath,
  removeAppTempFile,
  assertInputUnchanged,
} from '../../src/main/services/FileFinalizeService';
import { decodePoints, durationTolerance } from '../../src/main/services/OutputValidationService';
import { MAX_TARGET_ATTEMPTS, TARGET_RETRY_SAFETY } from '../../src/main/services/JobRunner';
import { ProgressEstimator } from '../../src/main/services/ProgressEstimator';
import { AppError } from '../../src/main/services/AppError';
import { AppSettingsSchemaCheck } from './schemaHelpers';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-unit-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('출력 파일 확정과 원본 보호', () => {
  it('이름이 겹치면 " (2)" 번호를 붙인다', () => {
    const input = path.join(dir, 'clip.mp4');
    fs.writeFileSync(input, 'x');
    fs.writeFileSync(path.join(dir, 'clip-slim.mp4'), 'existing');
    const p = resolveFinalPath(dir, 'clip-slim', 'mp4', input);
    expect(path.basename(p)).toBe('clip-slim (2).mp4');
  });

  it('출력 경로가 원본과 같으면 다음 번호로 넘어간다', () => {
    const input = path.join(dir, 'clip.mp4');
    const p = resolveFinalPath(dir, 'clip', 'mp4', input);
    expect(path.basename(p)).toBe('clip (2).mp4');
  });

  it('확정은 기존 파일을 덮어쓰지 않는다', () => {
    const temp = path.join(dir, '.a.vslim-tmp-12345678.mp4');
    const final = path.join(dir, 'a-slim.mp4');
    fs.writeFileSync(temp, 'new');
    fs.writeFileSync(final, 'old');
    expect(() => finalizeFile(temp, final)).toThrow(AppError);
    expect(fs.readFileSync(final, 'utf8')).toBe('old');
  });

  it('정상 확정 시 임시 파일은 사라지고 결과가 최종 이름으로 남는다', () => {
    const temp = tempOutputPath(dir, 'b-slim', '12345678-aaaa', 'mkv');
    const final = path.join(dir, 'b-slim.mkv');
    fs.writeFileSync(temp, 'data');
    finalizeFile(temp, final);
    expect(fs.existsSync(temp)).toBe(false);
    expect(fs.readFileSync(final, 'utf8')).toBe('data');
  });

  it('앱 임시 파일이 아니면 정리 함수가 건드리지 않는다', () => {
    const user = path.join(dir, 'user-file.mp4');
    fs.writeFileSync(user, 'keep');
    removeAppTempFile(user);
    expect(fs.existsSync(user)).toBe(true);
  });

  it('입력이 분석 이후 바뀌었으면 INPUT_CHANGED 로 막는다', () => {
    const input = path.join(dir, 'c.mp4');
    fs.writeFileSync(input, 'abc');
    const st = fs.statSync(input);
    fs.appendFileSync(input, 'more');
    expect(() => assertInputUnchanged(input, { sizeBytes: st.size, mtimeMs: st.mtimeMs })).toThrow(
      /INPUT_CHANGED/,
    );
  });

  it('Windows 경로 비교는 대소문자를 무시한다', () => {
    expect(isSamePath('C:\\Videos\\A.mp4', 'c:\\videos\\a.mp4', 'win32')).toBe(true);
    expect(isSamePath('/x/A.mp4', '/x/a.mp4', 'linux')).toBe(false);
  });
});

describe('검증 허용 오차와 디코딩 지점', () => {
  it('재생 길이 허용 오차는 최소 0.75초이고 긴 영상에서는 0.5% 를 따른다', () => {
    expect(durationTolerance(10)).toBe(0.75);
    expect(durationTolerance(1000)).toBeCloseTo(5);
  });

  it('짧은 영상은 디코딩 지점이 범위를 넘거나 겹치지 않는다', () => {
    expect(decodePoints(1)).toEqual([0]);
    const pts = decodePoints(3);
    expect(pts[0]).toBe(0);
    expect(Math.max(...pts)).toBeLessThanOrEqual(1);
    expect(new Set(pts).size).toBe(pts.length);
  });

  it('긴 영상은 시작·중간·끝 세 지점을 검사한다', () => {
    expect(decodePoints(100)).toEqual([0, 49, 98]);
  });
});

describe('목표 용량 재시도 상한', () => {
  it('자동 재시도는 최대 3회이고 안전 계수는 1보다 작다', () => {
    expect(MAX_TARGET_ATTEMPTS).toBe(3);
    expect(TARGET_RETRY_SAFETY).toBeLessThan(1);
  });
});

describe('설정 스키마', () => {
  it('정상 설정은 통과하고 경로 주입 문자는 거부된다', () => {
    expect(AppSettingsSchemaCheck.ok({})).toBe(true);
    expect(AppSettingsSchemaCheck.ok({ outputSuffix: 'a/b' })).toBe(false);
    expect(AppSettingsSchemaCheck.ok({ ffmpegPath: '/x\0y' })).toBe(false);
  });
});

export const _unused = ProgressEstimator;
