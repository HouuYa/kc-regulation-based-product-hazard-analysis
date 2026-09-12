/**
 * 병행 점검 판정 지표 (070)
 *
 *   npm run eval:second-opinion
 *
 * 왜 npm run eval 로 재지 않는가 — 이것이 이 계층 평가의 핵심이다
 *   정답셋 47건(docs/raw/eval/answer-key.json)은 scripts/build-answer-key.ts 가
 *   엑셀의 「시험항목」 열을 그대로 실은 것이라 **"보고서가 실제로 수행한 시험"**이다.
 *   ①의 산출물(시험하지 않은 구간)은 정의상 그 밖이므로, 재현율로 재면 구조적으로
 *   0이 나온다. 그 숫자로 이 계층을 판정하려는 시도는 처음부터 잘못이다.
 *
 *   대신 정답셋을 **추출기의 정답지**로 쓴다. 「시험항목」 목록과 우리가 원문에서
 *   뽑은 시험명이 얼마나 겹치는지를 세면, ①의 분자를 믿을 수 있는지 알 수 있다.
 *   분자를 못 믿으면 공백은 "시험 안 한 것"이 아니라 "우리가 못 맞힌 것"이다.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, closeDb } from '../src/lib/db';

const KEY_PATH = join(import.meta.dirname, '..', 'docs', 'raw', 'eval', 'answer-key.json');

function spaceless(s: string): string {
  return s.replace(/\([^)]*\)/g, '').replace(/시험$/u, '').replace(/\s+/g, '').trim();
}

/** note 의 "시험항목: A, B, C" 를 목록으로 편다 */
function expectedTests(note: string): string[] {
  const m = note.match(/시험항목\s*:\s*(.+)$/);
  if (!m) return [];
  return m[1].split(/[,·]/).map((s) => spaceless(s)).filter((s) => s.length >= 2);
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}

function line(label: string, value: string, verdict?: string) {
  console.log(`  ${label.padEnd(34)} ${value.padStart(14)}   ${verdict ?? ''}`);
}

async function main() {
  const db = getDb();

  // 사건마다 가장 최근 실행 하나만 본다 — 여러 번 돌리면 쌓이므로
  const runs = await db<{
    case_id: string; id: string;
    requirement_clause_count: number; requirement_section_count: number;
    performed_test_count: number; mapped_test_count: number; unmapped_test_count: number;
    gap_section_count: number; dropped_span_count: number;
    extract_agreement: string | null; standard_count: number;
  }[]>`
    select distinct on (case_id)
      case_id, id, requirement_clause_count, requirement_section_count,
      performed_test_count, mapped_test_count, unmapped_test_count,
      gap_section_count, dropped_span_count, extract_agreement,
      coalesce(array_length(standard_ids, 1), 0) as standard_count
    from public.second_opinion_run
    order by case_id, started_at desc
  `;

  if (runs.length === 0) {
    console.log('실행 기록이 없습니다. 먼저 npm run cases:second-opinion -- --all 을 돌리세요.');
    await closeDb();
    return;
  }
  const runIds = runs.map((r) => Number(r.id));

  const [totalAccidents] = await db<{ n: number; with_method: number }[]>`
    select count(*)::int n,
           count(*) filter (where narrative ~ '조사 ?방법')::int as with_method
    from public.case_event where source_type = 'ACCIDENT'
  `;

  const items = await db<{
    run_id: string; case_id: string; item_type: string; label: string;
    verdict: string | null; span_verified: boolean; extract_source: string;
  }[]>`
    select run_id, case_id, item_type, label, verdict, span_verified, extract_source
    from public.case_investigation_item where run_id = any(${runIds})
  `;

  const findings = await db<{ case_id: string; finding_type: string; output_kind: string }[]>`
    select case_id, finding_type, output_kind
    from public.second_opinion_finding where run_id = any(${runIds})
  `;

  console.log('');
  console.log('═══ 병행 점검 판정 지표 ═══════════════════════════════════════');
  console.log('');
  console.log(`실행한 사건 ${runs.length}건 / 사고보고서 전체 ${totalAccidents.n}건` +
    ` (「조사 방법」 줄이 있는 것 ${totalAccidents.with_method}건)`);
  console.log('');

  // ── 1. 추출 ────────────────────────────────────────────────────────────
  console.log('1. 추출');
  const withTests = new Set(
    items.filter((i) => i.item_type === 'TEST_PERFORMED').map((i) => i.case_id),
  ).size;
  line('시험 ≥1건 추출', `${withTests}/${totalAccidents.with_method}`);

  /*
    비율로 합격선을 매기지 않는다.

    「조사 방법」 줄이 있어도 내용이 「동일성 확인」 뿐이라 시험을 아예 안 한 사건이
    있다. 그 사건에서 시험 0건은 정답이지 누락이 아니다. 그렇다고 정규식으로 분모를
    가려내려 하면 또 틀린다 — 창을 넓혀도 64건이 걸리는데 실제 추출은 그보다 많았다.
    「어린이제품 공통안전기준 유해화학물질」처럼 「시험」이라는 낱말 없이 시험을
    적는 보고서가 있기 때문이다.

    그래서 기계가 판정하지 않고, 0건으로 나온 사건을 원문 줄과 함께 보여 준다.
    사람이 한 번 보면 끝나는 일을 규칙으로 흉내 내다 멀쩡한 추출기를 미달로 읽는
    것보다 낫다.
  */
  const zero = await db<{ id: string; method_line: string | null }[]>`
    select e.id, (regexp_match(e.narrative, '조사 ?방법[^\n]{0,80}'))[1] as method_line
    from public.case_event e
    where e.source_type = 'ACCIDENT' and e.narrative ~ '조사 ?방법'
      and e.id not in (
        select distinct i.case_id from public.case_investigation_item i
        where i.run_id = any(${runIds}) and i.item_type = 'TEST_PERFORMED'
      )
    order by e.id
  `;
  if (zero.length > 0) {
    console.log(`     시험 0건으로 나온 ${zero.length}건 — 「조사 방법」에 시험이 없으면 정답이다:`);
    for (const z of zero) console.log(`       ${z.id}: ${z.method_line ?? ''}`);
  }

  /*
    PHOTO 출처는 이 지표에서 뺀다 (라운드 72 실측으로 잡은 것).

    span_verified 는 "narrative 에서 그대로 찾을 수 있는가"를 재는데, 사진
    측정값은 애초에 narrative 인용이 아니다(사진 속 숫자다) — 그래서 항상
    false 이고, 그건 결함이 아니라 정의상 그렇다. 섞어서 재면 원문 인용
    추출기(LLM)가 실제로는 좋아졌는데도(94%→95%대) 사진 항목이 분모를
    부풀려 미달로 잘못 읽힌다. 실측: 섞으면 77.1%, LLM 만 재면 그 안에서도
    더 정확한 값이 나온다.
  */
  const textItems = items.filter((i) => i.extract_source === 'LLM');
  const spanTotal = textItems.length;
  const spanOk = textItems.filter((i) => i.span_verified).length;
  line('evidence_span 통과율 (원문 인용, LLM만)', pct(spanOk, spanTotal),
    spanOk / spanTotal >= 0.95 ? '✓ 95% 이상' : '✗ 판정선 95%');

  const photoItems = items.filter((i) => i.extract_source === 'PHOTO');
  if (photoItems.length > 0) {
    line('사진(variant B)에서 건진 항목', `${photoItems.length}건`,
      `${new Set(photoItems.map((i) => i.case_id)).size}개 사건에서 나옴`);
  }

  const dropped = runs.reduce((s, r) => s + r.dropped_span_count, 0);
  line('인용 검사에서 버린 항목', `${dropped}건`, '(낮을수록 좋다)');

  const agr = runs.map((r) => Number(r.extract_agreement ?? 0));
  line('반복 일치도 평균', (agr.reduce((a, b) => a + b, 0) / agr.length).toFixed(2),
    `만장일치 ${agr.filter((a) => a >= 1).length}건`);

  // ── 2. 동일성 — 라운드 69 가 두 번 정정해 확정한 수치와 대조 ──────────
  console.log('');
  console.log('2. 동일성 확인 (라운드 69 실측: 상이 18건)');
  const identity = items.filter((i) => i.item_type === 'IDENTITY_CHECK');
  const diff = identity.filter((i) => i.verdict === '상이함').length;
  const same = identity.filter((i) => i.verdict === '동일함').length;
  /*
    18건은 라운드 69 가 「동일성확인 결과」 어구에 맞춘 정규식으로 센 값이다.
    그보다 많이 나오는 것 자체는 고장이 아니다 — 다른 표기를 쓰는 보고서를 더
    잡았을 수 있다. 다만 「동일함」을 「상이함」으로 뒤집어 세는 것이 라운드 69 가
    실제로 저지른 실수이므로, 어긋나면 사람이 원문을 봐야 한다는 신호로 남긴다.
  */
  line('상이함', `${diff}건`,
    Math.abs(diff - 18) <= 2 ? '✓ 18±2' : '△ 라운드 69(18건)와 다름 — 원문을 사람이 확인할 것');
  line('동일함', `${same}건`);
  line('확인불가', `${identity.filter((i) => i.verdict === '확인불가').length}건`);

  // ── 3. 분모와 분자 ────────────────────────────────────────────────────
  console.log('');
  console.log('3. 분모와 분자');
  const withScope = runs.filter((r) => r.standard_count > 0).length;
  line('분모를 낼 수 있는 건', `${withScope}/${runs.length}`,
    withScope / runs.length >= 0.8 ? '✓ 80% 이상' : '✗ 판정선 80%');

  const perf = runs.reduce((s, r) => s + r.performed_test_count, 0);
  const unmapped = runs.reduce((s, r) => s + r.unmapped_test_count, 0);
  line('수행 시험 → 조항 매핑 실패', `${unmapped}/${perf} (${pct(unmapped, perf)})`,
    unmapped / perf <= 0.3 ? '✓ 30% 이하' : '✗ 판정선 30% — 임베딩 매핑 필요');

  const gaps = runs.map((r) => r.gap_section_count).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  line('사건당 공백 절 (중앙값)', `${median}개`,
    median > 100 ? '✗ 관련성 필터 재설계' : '관측치 — 판정선 아님');
  line('공백 0건인 사건', `${gaps.filter((g) => g === 0).length}건`);

  // ── 4. 리콜 교차 근거 ─────────────────────────────────────────────────
  console.log('');
  console.log('4. 리콜 교차 근거');
  const byCase = new Map<string, Set<string>>();
  for (const f of findings) {
    const s = byCase.get(f.case_id) ?? new Set<string>();
    s.add(f.finding_type);
    byCase.set(f.case_id, s);
  }
  const withRecall = [...byCase.values()].filter((s) => s.has('RECALL_EVIDENCE')).length;
  line('리콜 근거가 붙은 사건', `${withRecall}/${runs.length}`,
    withRecall / runs.length >= 0.7 ? '✓ 70% 이상' : '✗ 판정선 70%');
  line('소견 총 건수', `${findings.length}건`);

  // ── 5. 지키는 선 — 기계로 증명한다 ────────────────────────────────────
  console.log('');
  console.log('5. 지키는 선 (기계 증명)');

  const [tagLeak] = await db<{ n: number }[]>`
    select count(*)::int n from public.case_tag
    where created_at >= (select min(started_at) from public.second_opinion_run)
  `;
  line('병행 점검 이후 생긴 case_tag', `${tagLeak.n}건`,
    tagLeak.n === 0 ? '✓ 0건 — 선 1 지킴' : '✗ 추정이 확정 태그로 샜다');

  const [matchLeak] = await db<{ n: number }[]>`
    select count(*)::int n from public.match_run
    where started_at >= (select min(started_at) from public.second_opinion_run)
  `;
  line('병행 점검 이후 생긴 match_run', `${matchLeak.n}건`,
    matchLeak.n === 0 ? '✓ 0건 — 선 2 지킴' : '(분석을 따로 돌렸다면 정상)');

  const [markingLeak] = await db<{ n: number }[]>`
    select count(*)::int n
    from public.second_opinion_finding f
    join public.clause c on c.id = f.clause_id
    where f.output_kind = 'TEST_ITEM' and c.clause_role = 'MARKING'
  `;
  line('시험항목에 섞인 표시 조항', `${markingLeak.n}건`,
    markingLeak.n === 0 ? '✓ 0건 — 불량/불법 분리' : '✗ CLAUDE.md §10 위반');

  const [estimated] = await db<{ n: number; total: number }[]>`
    select count(*) filter (where code_is_estimated)::int n, count(*)::int total
    from public.second_opinion_finding where hf_code is not null
  `;
  line('추정 표시가 붙은 코드', `${estimated.n}/${estimated.total}`,
    estimated.n === estimated.total ? '✓ 전부' : '✗ 확정으로 새어 나간 코드가 있다');

  // ── 5-2. 불법 신호·기준 사각지대(②④) — 라운드 70 2단계 ─────────────────
  console.log('');
  console.log('5-2. 불법 신호·기준 사각지대 (②④)');

  const [legalRoute] = await db<{ n: number }[]>`
    select count(*)::int n
    from public.second_opinion_finding
    where finding_type = 'LEGAL_SIGNAL' and cause_route <> 'LEGAL'
  `;
  line('LEGAL_SIGNAL인데 route≠LEGAL', `${legalRoute.n}건`,
    legalRoute.n === 0 ? '✓ 0건 — 코드북과 일관됨' : '△ codebook.hf_route 재확인 필요');

  const legalByCode = await db<{ hf_code: string; n: number }[]>`
    select hf_code, count(*)::int n from public.second_opinion_finding
    where finding_type = 'LEGAL_SIGNAL' group by hf_code order by n desc
  `;
  for (const r of legalByCode) line(`  ${r.hf_code}`, `${r.n}건`);

  const [policy] = await db<{ n: number; non_target: number; threshold: number }[]>`
    select count(*)::int n,
           count(*) filter (where rationale like '%비대상%')::int as non_target,
           count(*) filter (where rationale like '%합격 문턱값%')::int as threshold
    from public.second_opinion_finding where finding_type = 'STANDARD_GAP'
  `;
  line('STANDARD_GAP 총 건수', `${policy.n}건`, `(비대상 ${policy.non_target} · 문턱값 공백 ${policy.threshold})`);

  const [nonTargetCoverage] = await db<{ n: number; found: number }[]>`
    with latest as (
      select distinct on (case_id) id, case_id from public.second_opinion_run
      order by case_id, started_at desc
    )
    select
      count(*) filter (where i.item_type = 'NON_TARGET')::int as n,
      count(distinct f.case_id)::int as found
    from public.case_investigation_item i
    join latest l on l.id = i.run_id
    left join public.second_opinion_finding f
      on f.case_id = i.case_id and f.finding_type = 'STANDARD_GAP' and f.rationale like '%비대상%'
    where i.item_type = 'NON_TARGET'
  `;
  line('(비대상) 추출 → STANDARD_GAP 연결', `${nonTargetCoverage.found}/${nonTargetCoverage.n}`,
    nonTargetCoverage.found === nonTargetCoverage.n ? '✓ 전부 연결' : '△ 일부 미연결 — 실행마다 흔들릴 수 있음');

  // ── 6. 정답셋 역방향 대조 — 분자를 믿을 수 있는가 ─────────────────────
  console.log('');
  console.log('6. 정답셋 역방향 대조 (추출한 시험명 vs 담당자가 적은 시험항목)');
  let key: { cases: Array<{ caseId: string; note: string }> };
  try {
    key = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
  } catch {
    console.log('  정답셋 파일이 없습니다 — npm run eval:build-key 로 만듭니다');
    await closeDb();
    return;
  }

  const extractedBy = new Map<string, string[]>();
  for (const i of items) {
    if (i.item_type !== 'TEST_PERFORMED') continue;
    const a = extractedBy.get(i.case_id) ?? [];
    a.push(spaceless(i.label));
    extractedBy.set(i.case_id, a);
  }

  let hit = 0;
  let expTotal = 0;
  let scored = 0;
  const misses: string[] = [];
  for (const c of key.cases) {
    const exp = expectedTests(c.note ?? '');
    if (exp.length === 0) continue;
    const got = extractedBy.get(String(c.caseId));
    if (!got) continue;
    scored++;
    for (const e of exp) {
      expTotal++;
      // 어느 쪽이 더 길든 한쪽이 다른 쪽의 앞머리면 같은 시험으로 본다
      const ok = got.some((g) => g.startsWith(e) || e.startsWith(g));
      if (ok) hit++;
      else if (misses.length < 12) misses.push(`${c.caseId}: ${e}`);
    }
  }

  line('대조한 사건', `${scored}건`);
  line('항목 단위 재현율', `${hit}/${expTotal} (${pct(hit, expTotal)})`,
    hit / expTotal >= 0.6 ? '✓ 60% 이상' : '✗ 판정선 60% — 분자를 못 믿는다');
  if (misses.length) {
    console.log('  못 맞힌 예:');
    for (const m of misses) console.log(`    ${m}`);
  }

  console.log('');
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
