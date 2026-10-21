// Windows 패키지 오프라인 검증.
//
// 설치 파일(NSIS)과 포터블 실행 파일을 7z 로 풀어 다음을 확인한다. 설치를 실행하지 않는다.
//  - 앱 실행 파일과 app.asar, 번들 FFmpeg(ffmpeg.exe, ffprobe.exe)의 존재
//  - 번들 FFmpeg 의 SHA-256 이 scripts/fetch-ffmpeg-win.mjs 의 고정값과 같은지
//  - GPL 라이선스 전문과 제3자 고지의 포함 여부
//  - 앱 실행 파일에 버전 정보 문자열(ProductName, FileDescription)이 들어 있는지
// 사용: node scripts/verify-win-package.mjs [release 디렉터리]   (7z 가 PATH 에 있어야 한다)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.resolve(process.argv[2] ?? path.join(ROOT, 'release'));
const EXPECTED = {
  'resources/binaries/win32-x64/ffmpeg.exe':
    'e9fd5e711debab9d680955fc1e38a2c1160fd280b144476cc3f62bc43ef49db1',
  'resources/binaries/win32-x64/ffprobe.exe':
    '139f8420bcb2f29fcd5734e29d686289df826cadce5d2b7b5f56d0000ea9a951',
};
const REQUIRED = [
  'VideoSlim Desktop.exe',
  'resources/app.asar',
  'resources/licenses/ffmpeg/COPYING.GPLv3',
  'resources/licenses/ffmpeg/BUILD-README.txt',
  'resources/licenses/THIRD_PARTY_NOTICES.md',
];

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const problems = [];

function verifyArchive(exe) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-verify-'));
  try {
    execFileSync('7z', ['x', '-y', `-o${tmp}`, exe], { stdio: 'ignore' });
    const app7z = path.join(tmp, '$PLUGINSDIR', 'app-64.7z');
    if (!fs.existsSync(app7z)) {
      problems.push(`${path.basename(exe)}: app-64.7z 페이로드가 없습니다`);
      return;
    }
    const appDir = path.join(tmp, 'app');
    execFileSync('7z', ['x', '-y', `-o${appDir}`, app7z], { stdio: 'ignore' });
    for (const rel of REQUIRED) {
      if (!fs.existsSync(path.join(appDir, rel)))
        problems.push(`${path.basename(exe)}: ${rel} 누락`);
    }
    for (const [rel, hash] of Object.entries(EXPECTED)) {
      const f = path.join(appDir, rel);
      if (!fs.existsSync(f)) problems.push(`${path.basename(exe)}: ${rel} 누락`);
      else if (sha256(f) !== hash) problems.push(`${path.basename(exe)}: ${rel} SHA-256 불일치`);
    }
    const mainExe = path.join(appDir, 'VideoSlim Desktop.exe');
    if (fs.existsSync(mainExe)) {
      const data = fs.readFileSync(mainExe);
      for (const key of ['ProductName', 'FileDescription', 'VideoSlim Desktop']) {
        if (!data.includes(Buffer.from(key, 'utf16le')))
          problems.push(`${path.basename(exe)}: 실행 파일에 버전 정보 ${key} 가 없습니다`);
      }
    }
    console.log(`확인: ${path.basename(exe)} (페이로드 ${String(fs.statSync(app7z).size)} 바이트)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const files = fs
  .readdirSync(RELEASE)
  .filter((n) => /^VideoSlim Desktop-(Setup|Portable)-.*\.exe$/.test(n));
if (files.length === 0) {
  console.error(`${RELEASE} 에 설치 파일이 없습니다. 먼저 npm run pack:win 을 실행하세요.`);
  process.exit(1);
}
for (const f of files) verifyArchive(path.join(RELEASE, f));
if (problems.length > 0) {
  for (const p of problems) console.error(`문제: ${p}`);
  process.exit(1);
}
console.log('Windows 패키지 오프라인 검증 통과. 실제 설치·실행은 Windows 11 에서 확인해야 합니다.');
