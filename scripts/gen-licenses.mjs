// 런타임 의존성(프로덕션)의 이름·버전·라이선스를 모아 resources/licenses/THIRD_PARTY_NOTICES.md 를 만든다.
// 사용: node scripts/gen-licenses.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tree = JSON.parse(
  execSync('npm ls --omit=dev --all --json', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);

const seen = new Map();
function walk(node) {
  for (const [name, info] of Object.entries(node.dependencies ?? {})) {
    const key = `${name}@${info.version}`;
    if (!seen.has(key)) {
      const pkgJson = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
      let license = 'UNKNOWN';
      let repository = '';
      if (fs.existsSync(pkgJson)) {
        const pj = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
        license =
          typeof pj.license === 'string' ? pj.license : JSON.stringify(pj.license ?? 'UNKNOWN');
        repository = typeof pj.repository === 'string' ? pj.repository : (pj.repository?.url ?? '');
      }
      seen.set(key, { name, version: info.version, license, repository });
    }
    walk(info);
  }
}
walk(tree);

const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const today = new Date().toISOString().slice(0, 10);
const lines = [
  '# 제3자 소프트웨어 고지 (Third-Party Notices)',
  '',
  `생성일: ${today} (scripts/gen-licenses.mjs 로 생성, 수동 편집 금지)`,
  '',
  '## 1. 런타임 npm 의존성',
  '',
  '| 패키지 | 버전 | 라이선스 | 저장소 |',
  '| --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${r.repository} |`),
  '',
  '## 2. Electron (런타임)',
  '',
  'Electron 은 MIT 라이선스이며, 번들에 포함된 Chromium 과 Node.js 의 고지는 설치 폴더의 LICENSE.electron.txt 와 LICENSES.chromium.html 을 따른다.',
  '',
  '## 3. FFmpeg / ffprobe (번들하지 않음)',
  '',
  '현재 배포 빌드에는 FFmpeg 바이너리가 포함되어 있지 않다. 사용자가 설정에서 지정하거나 PATH 의 FFmpeg 를 사용한다.',
  '번들 배포로 전환할 때는 resources/binaries/README.md 의 조건(LGPL 빌드, 소스 제공, 빌드 구성 기록)을 충족해야 한다.',
  '',
];
const out = path.join(root, 'resources', 'licenses', 'THIRD_PARTY_NOTICES.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`wrote ${out} (${String(rows.length)} packages)`);
