/**
 * 사고 사전 검토 — 조사 전 / 조사 뒤 기준선 (06_02 P0-1·P0-3)
 *
 *   npm run eval:pre-review -- --mask-check            결과 칸 가리기만 검사 (AI 호출 없음)
 *   npm run eval:pre-review -- --case 5556             한 건 (AI 호출 있음 — 먼저 이것으로 비용 확인)
 *   npm run eval:pre-review -- --all                   전기용품 전부 (담당자 승인 후)
 *   npm run eval:pre-review -- --all --group 생활용품   다른 대분류
 *
 * 로직은 src/lib/eval/pre-review.ts 에 있다. 여기는 인자와 출력만 맡는다(CLAUDE.md §9).
 * 아무것도 저장하지 않는다 — case_tag·match_run 을 건드리지 않는다(§13).
 */
import { getDb, closeDb } from '../src/lib/db';
import { intakePortion } from '../src/lib/second-opinion/narrative';
import { evaluateCase, accidentIdsInGroup, type PreReviewCase } from '../src/lib/eval/pre-review';
import { loadCodebookSnapshot } from '../src/lib/codebook/snapshot';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] ?? null : null;
}
const pct = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

/** 결과 칸이 정말 가려졌는가 — 남은 글에 결과 칸 제목이 없어야 한다 */
async function maskCheck(ids: number[]) {
  const rows = await getDb()<{ id: number; narrative: string }[]>`
    select id::int, narrative from public.case_event where id = any(${ids}) order by id
  `;
  const RESULT = /조사\s?확인\s?내용|조사\s?방법|동일성\s?확인\s?결과|원인의?\s?분석\s?결과|결함\s?조사\s?결과|적합함/;
  const COURSE = /사고\s?경위|조사\s?경위/;
  let cut = 0, leak = 0, noCourse = 0;
  const lens: number[] = [];
  for (const r of rows) {
    const p = intakePortion(r.narrative);
    if (!p) { console.log(`  가리지 못함  ${r.id} — 평가에서 뺀다`); continue; }
    cut++; lens.push(p.text.length);
    if (RESULT.test(p.text)) { leak++; console.log(`  결과가 남음  ${r.id}`); }
    if (!COURSE.test(p.text)) { noCourse++; console.log(`  경위가 없음  ${r.id}`); }
  }
  lens.sort((a, b) => a - b);
  console.log(`\n  가린 건 ${cut}/${rows.length} · 결과 남음 ${leak} · 경위 없음 ${noCourse}` +
    ` · 남은 길이 중앙값 ${lens[lens.length >> 1] ?? 0}자 · 최대 ${lens.at(-1) ?? 0}자`);
}

function summarize(results: PreReviewCase[]) {
  const ok = results.filter((r) => !r.skipped && r.pre && r.post);
  console.log(`\n═══ 요약 — 평가 ${ok.length}건 (뺀 것 ${results.length - ok.length}) ═══`);
  const goldSections = ok.reduce((s, r) => s + r.goldSections, 0);
  const withGold = ok.filter((r) => r.goldSections > 0);
  for (const cond of ['pre', 'post'] as const) {
    const label = cond === 'pre' ? '조사 전 (결과 칸 가림)' : '조사 뒤 (지금 저장된 그대로)';
    const hit = ok.reduce((s, r) => s + r[cond]!.goldSectionsHit, 0);
    const top5 = withGold.filter((r) => r[cond]!.top5Hit).length;
    const dt = ok.filter((r) => r.gold.dtPrimary && r[cond]!.dtPrimary === r.gold.dtPrimary).length;
    const hfKnown = ok.filter((r) => r.gold.hfPrimary && r.gold.hfPrimary !== 'HF.UNKNOWN');
    const hf = hfKnown.filter((r) => r[cond]!.hfPrimary === r.gold.hfPrimary).length;
    console.log(`\n  [${label}]`);
    console.log(`    3 시험 후보 — 정답 절 재현율(후보 20)   ${hit}/${goldSections} (${pct(hit, goldSections)})`);
    console.log(`    3 시험 후보 — 상위 5 적중 사건          ${top5}/${withGold.length} (${pct(top5, withGold.length)})`);
    if (cond === 'pre') {
      console.log(`    2 DT 대표 코드 일치                     ${dt}/${ok.length} (${pct(dt, ok.length)})`);
      console.log(`    2 HF 대표 코드 일치(원인 밝혀진 건만)   ${hf}/${hfKnown.length} (${pct(hf, hfKnown.length)})`);
    }
  }
  const tests = ok.reduce((s, r) => s + r.performedTests, 0);
  console.log(`\n  정답: 실제로 한 시험 ${tests}건 → 조항 절로 맞춘 것 ${goldSections}개 (절에 못 맞춘 시험은 정답에서 빠진다 — P0-4)`);
  console.log(`  1 제품분류 — 적용 기준을 찾은 사건 ${results.filter((r) => r.standardsFound > 0).length}/${results.length}`);
  console.log('  4 인증·표시 — 조사 전 확인 항목은 P1-5 에서 만든다 · 5 닮은 리콜 — 조사 전 임베딩 조건은 아직 못 잰다');
}

async function main() {
  const group = arg('--group') ?? '전기용품';
  const one = arg('--case');
  const ids = one ? [Number(one)] : await accidentIdsInGroup(group);

  if (process.argv.includes('--mask-check')) {
    console.log(`결과 칸 가리기 검사 — ${one ? `사건 ${one}` : `${group} ${ids.length}건`}`);
    await maskCheck(ids);
    await closeDb();
    return;
  }
  if (!one && !process.argv.includes('--all')) {
    console.error('AI 호출이 있습니다. --case <id> 로 먼저 한 건을 확인하고, 승인 후 --all 로 돌리세요 (CLAUDE.md §14).');
    process.exit(1);
  }

  const snapshot = await loadCodebookSnapshot();
  const results: PreReviewCase[] = [];
  for (const id of ids) {
    try {
      const r = await evaluateCase(id, snapshot);
      results.push(r);
      const line = r.skipped
        ? `뺌 — ${r.skipped}`
        : `정답 절 ${r.goldSections} · 조사 전 적중 ${r.pre!.goldSectionsHit}(상위5 ${r.pre!.top5Hit ? 'O' : 'X'})` +
          ` · 조사 뒤 적중 ${r.post!.goldSectionsHit}(상위5 ${r.post!.top5Hit ? 'O' : 'X'})` +
          ` · DT ${r.pre!.dtPrimary ?? '-'} / 정답 ${r.gold.dtPrimary ?? '-'}` +
          ` · HF ${r.pre!.hfPrimary ?? '-'} / 정답 ${r.gold.hfPrimary ?? '-'}`;
      console.log(`  [${id}] ${r.title ?? ''} — ${line}`);
    } catch (e) {
      console.error(`  [${id}] 실패: ${e instanceof Error ? e.message : e}`);
    }
  }
  summarize(results);
  await closeDb();
}

main().catch((e) => {
  console.error('실패:', e instanceof Error ? e.message : e);
  process.exit(1);
});
