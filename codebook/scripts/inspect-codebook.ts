/**
 * 코드북 파싱 결과를 DB 없이 눈으로 확인한다 (dry-run).
 *
 *   npm run codebook:inspect
 *   npm run codebook:inspect -- --json > .eval/codebook.json
 *
 * DB·API 키가 없어도 실행된다. 적재 전에 파싱이 맞는지 먼저 본다 —
 * 설계문서 §8.2 "파싱 실패 항목은 목록으로 보여 주고 직접 수정 후 재적재" 의 CLI 판.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parsePdr, versionFromFilename } from '../src/parse-pdr.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** 저장소 루트에서 코드북 MD 를 찾는다 */
export function findCodebookFile(): string {
  const explicit = process.argv.find((a) => a.endsWith('.md') && !a.startsWith('--'));
  if (explicit) return explicit;

  const hit = readdirSync(REPO_ROOT).find(
    (f) => f.endsWith('.md') && f.includes('위해요인') && f.includes('분류체계'),
  );
  if (!hit) {
    throw new Error(
      '코드북 MD 를 찾지 못했습니다. 경로를 인자로 주세요:\n' +
        '  npm run codebook:inspect -- "제품_위해요인_분류체계_정립_PDR_v0_9_7.md"',
    );
  }
  return join(REPO_ROOT, hit);
}

function main() {
  const path = findCodebookFile();
  const filename = path.split(/[\\/]/).pop()!;
  const md = readFileSync(path, 'utf8');
  const result = parsePdr(md);

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }

  const { hazard_factors: hf, damage_types: dt, constraints, keywords, failures } = result;

  console.log('파일      :', filename);
  console.log('버전      :', versionFromFilename(filename) ?? '(파일명에서 못 읽음)');
  console.log('');
  console.log('HF 코드   :', hf.length, '건');

  const byDepth = new Map<number, number>();
  for (const h of hf) byDepth.set(h.depth, (byDepth.get(h.depth) ?? 0) + 1);
  for (const [d, n] of [...byDepth].sort()) console.log(`  ${d}단 계위 : ${n}건`);

  const byLevel = new Map<string, number>();
  for (const h of hf) byLevel.set(h.mshell_level1, (byLevel.get(h.mshell_level1) ?? 0) + 1);
  console.log('  M-SHELL  :', [...byLevel].map(([k, v]) => `${k}=${v}`).join(' '));
  console.log('  통계 기본노출 제외(L0·L1):', hf.filter((h) => !h.is_recall_common).length, '건');
  console.log('  자동생성(상위 계위 보완) :', hf.filter((h) => h.source_section.startsWith('자동생성')).length, '건');

  console.log('');
  console.log('DT 코드   :', dt.length, '건 (PDR §0.6 기준 16건이어야 함)');
  const noSev = dt.filter((d) => d.severity_min === null);
  console.log('  심각도 미파싱 :', noSev.length, noSev.map((d) => d.code).join(', '));
  const noEn = dt.filter((d) => !d.name_en);
  console.log('  영문명 미보강 :', noEn.length, noEn.map((d) => d.code).join(', '));

  console.log('');
  console.log('조합 제약 :', constraints.length, '건');
  for (const c of constraints) {
    console.log(`  ${c.subject_prefix}.* → ${c.rule_type} [${c.requires_any_of.join(' | ')}]  (${c.source_section})`);
  }

  console.log('');
  console.log('키워드    :', keywords.length, '건 /', new Set(keywords.map((k) => k.code)).size, '개 코드');

  console.log('');
  if (failures.length === 0) {
    console.log('파싱 실패 : 없음');
  } else {
    console.log('파싱 실패 :', failures.length, '건');
    for (const f of failures.slice(0, 20)) {
      console.log(`  L${f.line_no} [${f.section}] ${f.reason}`);
    }
  }

  // 참조 무결성 — 키워드가 존재하지 않는 코드를 가리키면 적재 시 FK 위반이 난다
  const hfCodes = new Set(hf.map((h) => h.code));
  const dtCodes = new Set(dt.map((d) => d.code));
  const dangling = keywords.filter((k) =>
    k.axis === 'HF' ? !hfCodes.has(k.code) : !dtCodes.has(k.code),
  );
  const danglingConstraints = constraints.flatMap((c) =>
    [c.subject_prefix, ...c.requires_any_of].filter((code) => !hfCodes.has(code)),
  );

  console.log('');
  console.log('참조 무결성');
  console.log('  키워드 → 없는 코드 :', dangling.length,
    dangling.length ? `(${[...new Set(dangling.map((d) => d.code))].join(', ')})` : '');
  console.log('  제약   → 없는 코드 :', danglingConstraints.length,
    danglingConstraints.length ? `(${[...new Set(danglingConstraints)].join(', ')})` : '');

  console.log('');
  console.log('HF 표본 (계위별 1건씩)');
  for (const d of [...byDepth.keys()].sort()) {
    const s = hf.find((h) => h.depth === d)!;
    console.log(`  ${s.code}  |  ${s.name_ko}  |  ${(s.definition ?? '').slice(0, 40)}`);
  }
  console.log('');
  console.log('DT 표본');
  for (const s of dt.slice(0, 3)) {
    console.log(`  ${s.code}  |  ${s.name_ko}  |  ${s.name_en}  |  심각도 ${s.severity_min}~${s.severity_max}  |  ${s.eu_safetygate_type}`);
  }
}

// 다른 스크립트가 findCodebookFile 만 가져다 쓸 때 검사기가 함께 돌지 않도록 막는다
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
