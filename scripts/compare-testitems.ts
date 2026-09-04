/**
 * 사람이 정한 시험항목 vs 시스템이 제시한 조항 — 건별 대조 증빙
 *
 *   npm run eval:compare
 *
 * 재현율 숫자 하나로는 "왜 못 찾았는가"를 알 수 없다. 사건마다 사람이 무엇을
 * 지목했고 시스템이 무엇을 내놓았는지 나란히 적어야 원인이 보인다.
 * 이 스크립트는 그 대조표를 파일로 남긴다 — 나중에 되짚을 증빙이다.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { getDb, closeDb } from '../src/lib/db';
import { searchCandidates } from '../src/lib/search/match';
import { loadCaseInput, defaultMatchConfig } from '../src/lib/search/run';

const OUT = join(import.meta.dirname, '..', 'docs', '분석', '2026-09-05_시험항목_비교');

async function main() {
  const db = getDb();
  const key = JSON.parse(readFileSync('docs/eval/answer-key.json', 'utf8')) as
    { cases: Array<{ caseId: number; note?: string; expected: Array<{ standard: string; marker: string }> }> };
  const cfg = { ...defaultMatchConfig(), useRerank: false };

  mkdirSync(OUT, { recursive: true });
  const lines: string[] = [];
  const csv: string[] = ['사건,접수번호,품목,사람이지목한기준,사람이지목한절,시스템순위,시스템조항,판정'];

  let done = 0;
  for (const c of key.cases) {
    let input;
    try { input = await loadCaseInput(c.caseId); } catch { continue; }

    const [ev] = await db<{ title: string; item_name: string | null; scope_evidence: string | null }[]>`
      select title, item_name, scope_evidence from public.case_event where id = ${c.caseId}`;
    const acc = (c.note ?? '').match(/접수 (\S+)/)?.[1] ?? '';

    lines.push('');
    lines.push('='.repeat(100));
    lines.push(`사건 ${c.caseId} · 접수 ${acc} · 품목 "${ev?.item_name ?? '?'}"`);
    lines.push(`  코드: HF ${input.hfCodes.join(',') || '없음'} / DT ${input.dtCodes.join(',') || '없음'}`);
    lines.push(`  적용 기준: ${input.standardIds?.length ?? 0}종  ${ev?.scope_evidence?.slice(0, 110) ?? ''}`);

    if (!input.standardIds?.length) {
      lines.push('  → 품목 미확정으로 분석하지 않음');
      continue;
    }

    const cands = await searchCandidates(input, cfg);
    const rank = new Map<number, number>();
    cands.forEach((x, i) => rank.set(x.clauseId, i + 1));

    lines.push('');
    lines.push('  [사람이 지목한 것]');
    for (const e of c.expected) {
      const rows = await db<{ id: number; marker: string; body: string; role: string | null }[]>`
        select cl.id, cl.marker, left(btrim(cl.body), 70) as body, cl.clause_role as role
        from public.clause cl join public.standard s on s.id = cl.standard_id
        where s.is_current and s.display_name ilike ${'%' + e.standard + '%'}
          and (cl.marker = ${e.marker} or cl.marker like ${e.marker + '.%'})
        order by cl.order_index`;
      const hits = rows.filter((r) => rank.has(Number(r.id)));
      const verdict = rows.length === 0 ? '조항없음'
        : hits.length > 0 ? `찾음(${hits.map((h) => `${h.marker}=${rank.get(Number(h.id))}위`).join(', ')})`
        : '못찾음';
      lines.push(`    ${e.standard} 절 ${e.marker}  (하위 ${rows.length}개)  → ${verdict}`);
      csv.push([c.caseId, acc, ev?.item_name ?? '', e.standard, e.marker,
        hits.length ? hits.map((h) => rank.get(Number(h.id))).join(' ') : '',
        hits.map((h) => h.marker).join(' '), verdict].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }

    lines.push('');
    lines.push('  [시스템이 제시한 상위 10]');
    for (const x of cands.slice(0, 10)) {
      lines.push(`    ${String(rank.get(x.clauseId)).padStart(2)}위 ${x.standardName} ${x.marker}` +
        `  [${x.matchPath}/${x.evidenceLevel}]  ${x.body.slice(0, 58).replace(/\s+/g, ' ')}`);
    }
    done++;
  }

  writeFileSync(join(OUT, '건별_대조.txt'), lines.join('\n'), 'utf8');
  writeFileSync(join(OUT, '건별_대조.csv'), `\ufeff${csv.join('\r\n')}\r\n`, 'utf8');
  console.log(`대조한 사건 ${done}건 → ${OUT}`);
  await closeDb();
}
main().catch((e) => { console.error('실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
