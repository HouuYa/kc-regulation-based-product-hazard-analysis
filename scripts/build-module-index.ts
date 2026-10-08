/**
 * 모듈 색인 생성 — 코드를 처음 보는 사람·LLM 이 길을 찾게 하는 지도 (2026-10-08)
 *
 *   npm run docs:index            docs/모듈_색인.md 를 다시 만든다
 *   npm run docs:index -- --check 파일이 낡았으면 실패한다 (CI·커밋 전 확인용)
 *
 * 왜 손으로 쓰지 않나
 *   `docs/기능_지도.md` 는 「개념 → 담당 코드」를 사람이 정리한 표다. 이 파일은 그 아래
 *   층이다 — 파일마다 머리 주석의 첫 줄과 내보내는 이름을 그대로 뽑는다. 손으로 쓰면
 *   코드가 바뀔 때마다 낡는다. 이 저장소의 머리 주석은 「왜 만들었나」를 적는 관례라
 *   첫 줄만 모아도 지도가 된다. 머리 주석이 없는 파일은 「(머리 주석 없음)」으로 보인다 —
 *   그 자체가 "여기에 설명을 달아 달라"는 신호다.
 *
 * 대상: src/lib, src/app(page·layout·actions·route), src/components, scripts
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', '모듈_색인.md');
const SCAN: Array<{ dir: string; title: string; keep?: (name: string) => boolean }> = [
  { dir: 'src/lib', title: '공용 로직 (src/lib) — 화면·스크립트가 함께 쓰는 곳' },
  { dir: 'src/app', title: '화면과 API (src/app)', keep: (n) => /^(page|layout|actions|route|data)\.tsx?$|-actions\.ts$/.test(n) },
  { dir: 'src/components', title: '화면 부품 (src/components)' },
  { dir: 'scripts', title: '명령줄 스크립트 (scripts) — npm run 으로 부른다' },
];

function walk(dir: string, keep?: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (/\.(ts|tsx)$/.test(name) && !name.startsWith('_tmp_') && (!keep || keep(name))) out.push(p);
  }
  return out;
}

/** 첫 /** … *\/ 블록에서 사람이 읽을 첫 문장을 뽑는다 */
function headline(src: string): string {
  const m = src.match(/^\s*(?:'use [a-z]+';\s*)?(?:import[^;]*;\s*)*\/\*\*([\s\S]*?)\*\//);
  const block = m ?? src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!block) return '(머리 주석 없음)';
  const line = block[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .find((l) => l.length > 0 && !l.startsWith('@'));
  return (line ?? '(머리 주석 없음)').replace(/\|/g, '\\|').slice(0, 110);
}

function exportsOf(src: string): string {
  const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/gm)]
    .map((m) => m[1]);
  if (/^export default /m.test(src)) names.unshift('default');
  const shown = names.slice(0, 6).join(', ');
  return names.length > 6 ? `${shown} 외 ${names.length - 6}` : shown;
}

function build(): string {
  const lines: string[] = [
    '---',
    'created: 2026-10-08',
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    'description: 파일마다 머리 주석 첫 줄과 내보내는 이름을 모은 자동 생성 색인. 코드를 처음 보는 사람·LLM 이 길을 찾는 지도',
    'status: active',
    'related: [docs/기능_지도.md, docs/코드_읽는_법.md, CLAUDE.md, AGENTS.md]',
    '---',
    '',
    '# 모듈 색인 (자동 생성)',
    '',
    '`npm run docs:index` 로 다시 만든다 — **손으로 고치지 않는다.** 설명이 틀렸거나 비어 있으면 그 파일의 머리 주석을 고치고 다시 만든다. 개념 단위 지도(어떤 일을 어느 코드가 맡는가)는 [기능 지도](기능_지도.md)에 있다.',
    '',
  ];
  for (const s of SCAN) {
    lines.push(`## ${s.title}`, '', '| 파일 | 하는 일 (머리 주석 첫 줄) | 내보내는 것 |', '| --- | --- | --- |');
    for (const file of walk(join(ROOT, s.dir), s.keep)) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      lines.push(`| \`${rel}\` | ${headline(src)} | ${exportsOf(src)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const next = build();
if (process.argv.includes('--check')) {
  // 날짜 줄은 매일 바뀌므로 비교에서 뺀다
  const strip = (t: string) => t.replace(/^updated: .*$/m, '');
  let cur = '';
  try { cur = readFileSync(OUT, 'utf8'); } catch { /* 없으면 낡은 것으로 본다 */ }
  if (strip(cur) !== strip(next)) {
    console.error('docs/모듈_색인.md 가 낡았습니다. npm run docs:index 를 실행하세요.');
    process.exit(1);
  }
  console.log('모듈 색인이 최신입니다.');
} else {
  writeFileSync(OUT, next, 'utf8');
  console.log(`모듈 색인을 만들었습니다 → ${relative(ROOT, OUT)}`);
}
