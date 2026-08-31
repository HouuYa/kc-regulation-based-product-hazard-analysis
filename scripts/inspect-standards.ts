/**
 * 안전기준 파싱 결과를 DB 없이 확인한다 (dry-run).
 *
 *   npm run standards:inspect                       전체 76건 요약
 *   npm run standards:inspect -- --file "부속서 8"    한 건 상세
 *   npm run standards:inspect -- --links            성능요건→시험방법 연결 표본
 *
 * 이 스크립트의 목적은 설계문서 결정항목 1
 * "파싱 데이터에 성능요건↔시험방법 연결 정보가 포함되는가" 를 실측으로 답하는 것이다.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parseStandardJson } from '../src/lib/standards/parse-result-json.js';

const REPO_ROOT = join(import.meta.dirname, '..');
export const STANDARDS_DIR = join(REPO_ROOT, 'KC안전기준');

export function listStandardFiles(): string[] {
  return readdirSync(STANDARDS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort();
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function detail(file: string) {
  const raw = readFileSync(join(STANDARDS_DIR, file), 'utf8');
  const p = parseStandardJson(file, raw);

  console.log('파일        :', p.meta.source_filename);
  console.log('표시명      :', p.meta.display_name);
  console.log('인증구분    :', p.meta.cert_scheme, '| 부속서', p.meta.annex_no ?? '-', '| 기준번호', p.meta.standard_no ?? '-');
  console.log('품목        :', p.meta.item_name ?? '-');
  console.log('페이지/신뢰도:', p.meta.total_pages, '/', p.meta.ocr_confidence);
  console.log('');
  console.log('조항        :', p.clauses.length, '건');

  const byLevel = new Map<string, number>();
  for (const c of p.clauses) byLevel.set(c.level_code ?? '?', (byLevel.get(c.level_code ?? '?') ?? 0) + 1);
  console.log('  레벨분포  :', [...byLevel].sort().map(([k, v]) => `${k}=${v}`).join(' '));
  console.log('  부(part)  :', [...new Set(p.clauses.map((c) => c.part ?? '-'))].join(', '));

  console.log('');
  console.log('시험조건    :', p.test_conditions.length, '행');
  for (const t of p.test_conditions.slice(0, 5)) {
    console.log(`  [${t.clause_marker}] ${t.item_group ? t.item_group + ' / ' : ''}${t.item_name} = ${t.allowance_raw} (값 ${t.value_num} ${t.unit ?? ''}) → 시험 ${t.test_method_marker ?? '-'}`);
  }

  console.log('');
  console.log('조항 참조   :', p.links.length, '건');
  const byType = new Map<string, number>();
  for (const l of p.links) byType.set(`${l.link_source}/${l.link_type}`, (byType.get(`${l.link_source}/${l.link_type}`) ?? 0) + 1);
  console.log('  유형분포  :', [...byType].map(([k, v]) => `${k}=${v}`).join(' '));
  for (const l of p.links.filter((x) => x.link_type === 'TEST_METHOD').slice(0, 6)) {
    console.log(`  ${l.from_marker} → ${l.to_marker}  [${l.link_source}]  "${l.evidence_span.slice(0, 60)}"`);
  }

  if (p.warnings.length) {
    console.log('');
    console.log('경고        :', p.warnings.join(' / '));
  }
}

interface SchemeStat {
  files: number;
  clauses: number;
  linksResolved: number;
  linksUnresolved: number;
  testMethodResolved: number;
  conds: number;
  filesWithoutTestLink: string[];
}

function summary() {
  const files = listStandardFiles();
  const stats = new Map<string, SchemeStat>();
  const blank = (): SchemeStat => ({
    files: 0, clauses: 0, linksResolved: 0, linksUnresolved: 0,
    testMethodResolved: 0, conds: 0, filesWithoutTestLink: [],
  });

  console.log('파일', files.length, '건 파싱 중...\n');

  for (const f of files) {
    const raw = readFileSync(join(STANDARDS_DIR, f), 'utf8');
    const p = parseStandardJson(f, raw);
    const s = stats.get(p.meta.cert_scheme) ?? blank();

    s.files += 1;
    s.clauses += p.clauses.length;
    s.conds += p.test_conditions.length;
    s.linksResolved += p.links.filter((l) => l.resolved).length;
    s.linksUnresolved += p.links.filter((l) => !l.resolved).length;

    const tm = p.links.filter((l) => l.link_type === 'TEST_METHOD' && l.resolved).length;
    s.testMethodResolved += tm;
    if (tm === 0) s.filesWithoutTestLink.push(p.meta.display_name);

    stats.set(p.meta.cert_scheme, s);
  }

  const total = blank();
  console.log('인증구분        파일  조항    참조(해결/미해결)  시험연결  시험조건');
  console.log('─'.repeat(72));
  for (const [scheme, s] of [...stats].sort((a, b) => b[1].files - a[1].files)) {
    console.log(
      scheme.padEnd(14),
      String(s.files).padStart(4),
      String(s.clauses).padStart(6),
      `${s.linksResolved}/${s.linksUnresolved}`.padStart(16),
      String(s.testMethodResolved).padStart(9),
      String(s.conds).padStart(9),
    );
    total.files += s.files; total.clauses += s.clauses; total.conds += s.conds;
    total.linksResolved += s.linksResolved; total.linksUnresolved += s.linksUnresolved;
    total.testMethodResolved += s.testMethodResolved;
  }
  console.log('─'.repeat(72));
  console.log(
    '합계'.padEnd(14),
    String(total.files).padStart(4),
    String(total.clauses).padStart(6),
    `${total.linksResolved}/${total.linksUnresolved}`.padStart(16),
    String(total.testMethodResolved).padStart(9),
    String(total.conds).padStart(9),
  );

  console.log('');
  console.log('※ 미해결 참조 = 같은 기준 안에 대상 조항이 없는 참조.');
  console.log('   KC 60335-2-x 계열은 제1부(KC 60335-1)를 고쳐 쓰는 부분 표준이라');
  console.log('   "19.4에 명시한 내용에 따라" 처럼 다른 기준을 가리킨다. 기준 간 연결의 재료다.');

  console.log('');
  for (const [scheme, s] of stats) {
    if (!s.filesWithoutTestLink.length) continue;
    console.log(`[${scheme}] 시험연결 0건 : ${s.filesWithoutTestLink.length}/${s.files}건`);
    for (const n of s.filesWithoutTestLink.slice(0, 6)) console.log('   -', n);
  }
}

// 다른 스크립트가 listStandardFiles 만 가져다 쓸 때 검사기가 함께 돌지 않도록 막는다
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = argValue('--file');
  if (file) {
    const hit = listStandardFiles().find((f) => f.includes(file));
    if (!hit) {
      console.error(`"${file}" 를 포함하는 파일이 없습니다.`);
      process.exit(1);
    }
    detail(hit);
  } else {
    summary();
  }
}
