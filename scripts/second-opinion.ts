/**
 * 사고보고서 병행 점검 (070)
 *
 *   npm run cases:second-opinion -- --case 5614        한 건
 *   npm run cases:second-opinion -- --case 5614 --dry  저장하지 않고 결과만 본다
 *   npm run cases:second-opinion -- --all              사고보고서 전량
 *   npm run cases:second-opinion -- --all --limit 5    앞 5건만
 *
 * 로직은 전부 src/lib/second-opinion/ 에 있다. 이 파일은 인자 파싱과 출력뿐이다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { runSecondOpinion, type SecondOpinionOutcome } from '../src/lib/second-opinion/run';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function show(o: SecondOpinionOutcome) {
  console.log('');
  console.log(`━━ 사건 ${o.caseId} ${'━'.repeat(50)}`);

  if (o.skipped) {
    console.log(`  건너뜀: ${o.skipped}`);
    return;
  }

  const e = o.extract!;
  console.log('');
  console.log('보고서가 한 일');
  console.log(`  수행한 시험 ${e.tests_performed.length}건` +
    (e.tests_performed.length ? ` — ${e.tests_performed.map((t) => `${t.name}(${t.verdict})`).join(', ')}` : ''));
  console.log(`  동일성 확인  ${e.identity_check.present ? e.identity_check.conclusion : '절 없음'}` +
    (e.identity_check.differing_parts.length ? ` — ${e.identity_check.differing_parts.join(', ')}` : ''));
  if (e.identity_check.stated_impact) console.log(`    조사관 판단: ${e.identity_check.stated_impact}`);
  console.log(`  결론         ${e.conclusion.verdict}` +
    ` (원인 서술 ${e.conclusion.states_cause ? '있음' : '없음'}${e.conclusion.is_non_target ? ' · 비대상' : ''})`);
  if (e.measurements.length) {
    console.log(`  측정값 ${e.measurements.length}건 — ` +
      e.measurements.slice(0, 4).map((m) => `${m.label} ${m.value}${m.unit}`).join(', '));
  }
  if (e.marking_notes.length) console.log(`  표시 관련 서술 ${e.marking_notes.length}건`);

  const unmapped = o.matches.filter((m) => !m.mapped);
  console.log('');
  console.log('분모와 분자');
  console.log(`  적용 기준 ${o.standardIds.length}종 · 요건 조항 ${o.gap?.requirementClauseCount ?? 0}개` +
    ` · 요건 절 ${o.gap?.requirementSectionCount ?? 0}개`);
  console.log(`  그중 보고서가 시험한 절 ${o.gap?.testedSectionCount ?? 0}개`);
  if (unmapped.length) {
    console.log(`  ⚠ 조항으로 못 맞힌 시험 ${unmapped.length}건 — ${unmapped.map((m) => m.name).join(', ')}`);
    console.log('    (이것을 공백으로 세지 않는다. 분자가 빈 것이지 시험을 안 한 것이 아니다)');
  }

  console.log('');
  console.log(`시험 범위 공백 ${o.gap?.sections.length ?? 0}건`);
  for (const g of o.gap?.sections ?? []) {
    console.log(`  절 ${g.section} 「${g.title}」 ${g.standardName ?? ''}${g.part ? ` [${g.part}]` : ''}`);
    console.log(`    요건 ${g.clauseIds.length}개 중 ${g.hitClauses}개가 닿음` +
      ` (밀도 ${g.density} · 특이성 ${g.lift}) · ${g.relatedBy.join(', ')}`);
  }

  if (o.legal.length) {
    console.log('');
    console.log(`인증·표시 확인항목 ${o.legal.length}건 (시험항목 아님)`);
    for (const l of o.legal) console.log(`  ${l.hfCode} — ${l.rationale}`);
  }

  if (o.blindspots.length) {
    console.log('');
    console.log(`기준 사각지대 ${o.blindspots.length}건`);
    for (const b of o.blindspots) console.log(`  [${b.kind}] ${b.rationale}`);
  }

  console.log('');
  console.log('리콜 교차 근거');
  console.log(`  ${o.recall?.note ?? '—'}`);
  for (const c of o.recall?.statistical.slice(0, 5) ?? []) {
    console.log(`  통계  ${c.nameKo ?? c.hfCode} — ${c.support}/${c.sampleSize}건` +
      ` (${(c.confidence * 100).toFixed(0)}%, 특이성 ${c.lift}, ${c.route})`);
  }
  for (const s of o.recall?.similar.slice(0, 5) ?? []) {
    console.log(`  사례  ${(s.title ?? `사건 ${s.caseId}`).slice(0, 40)}` +
      ` — 유사도 ${s.similarity} · GPC ${s.gpcMatchLevel}${s.recallCountry ? ` · ${s.recallCountry}` : ''}`);
  }

  console.log('');
  console.log(`추출 일치도 ${o.agreement.toFixed(2)} · 모델 ${o.model}${o.escalated ? ' (승격)' : ''}` +
    ` · 인용 검사 탈락 ${o.droppedSpans}건` +
    ` · 토큰 입력 ${o.usage.inputTokens.toLocaleString()} / 출력 ${o.usage.outputTokens.toLocaleString()}`);
  if (o.droppedTexts.length) {
    console.log('  버린 인용(원문에서 글자 그대로 찾지 못함):');
    for (const d of o.droppedTexts) console.log(`    · ${d.replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  if (o.runId) console.log(`저장했습니다 (run ${o.runId})`);
}

async function main() {
  const dry = process.argv.includes('--dry');
  const one = arg('--case');
  const limit = Number(arg('--limit') ?? '0');

  let ids: number[];
  if (one) {
    ids = [Number(one)];
  } else if (process.argv.includes('--all')) {
    const rows = await getDb()<{ id: string }[]>`
      select id from public.case_event where source_type = 'ACCIDENT' order by id
    `;
    ids = rows.map((r) => Number(r.id));
    if (limit > 0) ids = ids.slice(0, limit);
  } else {
    console.log('--case <id> 또는 --all 이 필요합니다.');
    await closeDb();
    return;
  }

  const total = { input: 0, output: 0, reasoning: 0 };
  let ok = 0;
  let skipped = 0;

  for (const id of ids) {
    try {
      const o = await runSecondOpinion(id, { dry });
      show(o);
      if (o.skipped) skipped++;
      else ok++;
      total.input += o.usage.inputTokens;
      total.output += o.usage.outputTokens;
      total.reasoning += o.usage.reasoningTokens;
    } catch (e) {
      // 한 건이 죽어도 나머지는 돈다. 71건짜리 배치가 한 건 때문에 통째로 밀리면
      // 어디까지 처리됐는지 되짚어야 한다
      console.error(`사건 ${id} 실패:`, e instanceof Error ? e.message : e);
      skipped++;
    }
  }

  console.log('');
  console.log(`${'═'.repeat(60)}`);
  console.log(`처리 ${ok}건 · 건너뜀 ${skipped}건${dry ? ' (dry — 저장하지 않았습니다)' : ''}`);
  console.log(`토큰 입력 ${total.input.toLocaleString()} · 출력 ${total.output.toLocaleString()}` +
    ` (추론 ${total.reasoning.toLocaleString()} 포함)`);
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
