// Windows x64 용 FFmpeg 6.0 (gyan.dev essentials 빌드, GPL v3) 를 가져와 resources/binaries/win32-x64 에 배치한다.
//
// 출처: PyPI 패키지 ffmpeg-binaries 1.1.0 (win_amd64 휠). 휠 안의 README.txt 가 gyan.dev 빌드임을 밝힌다.
// 무결성: 휠과 두 실행 파일의 SHA-256 을 고정해 하나라도 다르면 실패한다.
// 라이선스: GPL v3. 배포 시 완전한 대응 소스 제공 의무가 있다 (docs/RELEASE_CHECKLIST.md 2절).
//
// 사용: node scripts/fetch-ffmpeg-win.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'resources', 'binaries', 'win32-x64');
const LICENSE_DIR = path.join(ROOT, 'resources', 'licenses', 'ffmpeg');

const PIN = {
  wheelUrl:
    'https://files.pythonhosted.org/packages/00/ba/b3b0bc096cf3662a7a771976145d060e6fdc5d51360d18adfc918ebdd017/ffmpeg_binaries-1.1.0-py3-none-win_amd64.whl',
  wheelSha256: '8d5fbaf2d28fcc72e8d2c22628977cf8863641592c9ec15358290490f9195b9e',
  members: {
    'ffmpeg/binaries/bin/ffmpeg.exe': {
      out: 'ffmpeg.exe',
      sha256: 'e9fd5e711debab9d680955fc1e38a2c1160fd280b144476cc3f62bc43ef49db1',
    },
    'ffmpeg/binaries/bin/ffprobe.exe': {
      out: 'ffprobe.exe',
      sha256: '139f8420bcb2f29fcd5734e29d686289df826cadce5d2b7b5f56d0000ea9a951',
    },
    'ffmpeg/binaries/LICENSE': { out: 'COPYING.GPLv3', sha256: null },
    'ffmpeg/binaries/README.txt': { out: 'BUILD-README.txt', sha256: null },
  },
};

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 이미 배치된 실행 파일이 고정 해시와 일치하면 다시 내려받지 않는다 */
function alreadyStaged() {
  return Object.entries(PIN.members)
    .filter(([member]) => member.endsWith('.exe'))
    .every(([, spec]) => {
      const dest = path.join(OUT_DIR, spec.out);
      return fs.existsSync(dest) && sha256(dest) === spec.sha256;
    });
}

function main() {
  if (alreadyStaged() && fs.existsSync(path.join(LICENSE_DIR, 'COPYING.GPLv3'))) {
    console.log('FFmpeg 번들이 이미 준비되어 있습니다 (SHA-256 일치). 다시 내려받지 않습니다.');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-ffmpeg-'));
  try {
    const wheel = path.join(tmp, 'ffmpeg-binaries.whl');
    // curl 은 HTTPS_PROXY 같은 환경 변수를 따른다 (Node fetch 는 기본적으로 따르지 않는다)
    execFileSync('curl', ['-fsSL', '-o', wheel, PIN.wheelUrl], { stdio: 'inherit' });
    const got = sha256(wheel);
    if (got !== PIN.wheelSha256) throw new Error(`휠 SHA-256 불일치: ${got}`);

    const extract = path.join(tmp, 'x');
    fs.mkdirSync(extract);
    if (process.platform === 'win32') {
      execFileSync('tar', ['-xf', wheel, '-C', extract], { stdio: 'inherit' }); // Windows 10+ 의 tar 는 zip 을 읽는다
    } else {
      execFileSync('unzip', ['-q', wheel, '-d', extract], { stdio: 'inherit' });
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(LICENSE_DIR, { recursive: true });
    for (const [member, spec] of Object.entries(PIN.members)) {
      const src = path.join(extract, ...member.split('/'));
      if (!fs.existsSync(src)) throw new Error(`휠에 ${member} 가 없습니다`);
      if (spec.sha256 !== null && sha256(src) !== spec.sha256) {
        throw new Error(`${member} SHA-256 불일치`);
      }
      const dest = member.endsWith('.exe')
        ? path.join(OUT_DIR, spec.out)
        : path.join(LICENSE_DIR, spec.out);
      fs.copyFileSync(src, dest);
      console.log(`배치: ${path.relative(ROOT, dest)}`);
    }
    console.log(
      'FFmpeg 번들 준비 완료 (GPL v3 고지와 소스 제공 의무는 docs/RELEASE_CHECKLIST.md 참조)',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
