/**
 * §5.8 정확도 비교표 — 0단계의 목적 그 자체
 *
 *   npm run eval                    정답셋으로 5개 구성을 비교
 *   npm run eval -- --case 4        한 사건만
 *   npm run eval -- --k 5           상위 k건 기준 (기본 5)
 *
 * 설계문서 §5.8 이 채우라고 한 표를 만든다.
 *
 *   구성                        재현율   오탐률   상위k 정답포함률
 *   ① 코드만
 *   ①+② 코드+키워드
 *   ①+②+③ 하이브리드
 *   + 맥락 결합
 *   + 리랭킹
 *
 * "각 행을 하나씩 켜면서 측정 — 한꺼번에 다 켜면 무엇이 효과를 냈는지 알 수 없다."
 *
 * 정답셋을 어디서 가져오는가 — v0.6 과 v0.7 이 갈리는 지점
 *   v0.6 §5.8 은 "정답지는 별도로 만들지 않음. 담당자가 실제로 채택·반려한
 *   기록(review_log)이 그대로 정답지가 된다"고 했다.
 *   v0.7 §0.2 는 이것을 "평가 설계 오류"로 지목했다 — 시스템이 제시한 후보를 보고
 *   담당자가 고른 기록은, 시스템이 애초에 제시하지 않은 조항을 정답에 포함할 수
 *   없다. 재현율의 분모가 시스템 출력에 의존하므로 재현율이 늘 부풀려진다.
 *
 *   그래서 두 경로를 모두 지원하되 기본은 v0.7 을 따른다.
 *     --source expert  docs/eval/answer-key.json (전문가가 시스템 결과 보기 전에 작성)
 *     --source review  review_log (운영 로그. 사후 개선용이며 정확도 근거로 쓰지 않는다)
 *   review 로 낸 수치에는 경고를 붙여 출력한다.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, closeDb } from '../src/lib/db';
import { standardsForCase } from '../src/lib/cases/resolve-scope';
import { searchCandidates, type Candidate, type MatchConfig, type MatchInput } from '../src/lib/search/match';
import { withEstimatedCauses, mergeByRank } from '../src/lib/search/estimate-cause';
import { groupBySection, flattenSections, type SectionScoring } from '../src/lib/search/group-section';
import { rerankCandidates } from '../src/lib/llm/rerank';
import { openaiConfig, tuning } from '../src/lib/env';

/** 절로 묶기 전에 몇 건까지 훑을 것인가. 진단에서 정답의 49%가 상위 20 밖 200 안에 있었다 */
const SECTION_POOL = 200;

/**
 * LLM 을 쓰는 행을 뺀다 (`--no-llm`)
 *
 * 리랭킹은 사건마다 모델을 부르므로 정답셋 47건을 돌리면 호출이 수십 번 쌓인다.
 * 검색 쪽만 손보는 동안에는 그 비용을 낼 이유가 없다. 결론을 낼 때만 켠다.
 */
const noLlm = process.argv.includes('--no-llm');

const ANSWER_KEY = join(import.meta.dirname, '..', 'docs', 'eval', 'answer-key.json');

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/**
 * 전문가 정답셋 형식.
 *
 * 담당자가 시스템 결과를 보기 전에 "이 사고면 어느 조항의 시험을 의뢰하겠는가"를
 * 적어 둔 것이다. 조항은 (기준 표시명, 조항번호)로 지목한다 — clause id 는
 * 재적재하면 바뀌므로 정답셋에 넣으면 안 된다.
 */
interface AnswerKey {
  cases: Array<{
    caseId: number;
    note?: string;
    expected: Array<{ standard: string; marker: string; part?: string }>;
  }>;
}

interface Metrics {
  label: string;
  recall: number;
  falsePositiveRate: number;
  hitAtK: number;
  returned: number;
  expected: number;
  found: number;
}

/**
 * §5.8 이 켜라고 한 순서대로. 앞 행에서 한 갈래씩만 더한다
 *
 * 「+ 원인 다리」는 갈래를 켜는 것이 아니라 **입력을 바꾼다**(04-1 §8).
 * 원인이 미상인 사건에 추정 원인을 얹어 같은 하이브리드 구성으로 돌린다.
 * 다리를 켠 행과 끈 행이 나란히 찍혀야 효과를 그 자리에서 판정할 수 있다.
 */
interface EvalVariant {
  label: string;
  config: MatchConfig;
  bridge?: 'replace' | 'merge';
  section?: SectionScoring;
  /** 절로 묶기 전에 훑을 후보 수. 기본 SECTION_POOL */
  pool?: number;
  /** LLM 에게 몇 건을 보여 주고 고르게 할 것인가. 없으면 순서만 바꾼다 */
  rerankPool?: number;
}

function configs(base: MatchConfig): EvalVariant[] {
  const all: EvalVariant[] = [
    { label: '① 코드만', config: { ...base, useCode: true, useKeyword: false, useVector: false, useRerank: false } },
    { label: '①+② 코드+어휘', config: { ...base, useCode: true, useKeyword: true, useVector: false, useRerank: false } },
    { label: '①+②+③ 하이브리드', config: { ...base, useCode: true, useKeyword: true, useVector: true, useRerank: false } },
    { label: '+ 원인 다리(대체)', config: { ...base, useCode: true, useKeyword: true, useVector: true, useRerank: false }, bridge: 'replace' },
    { label: '+ 원인 다리(병합)', config: { ...base, useCode: true, useKeyword: true, useVector: true, useRerank: false }, bridge: 'merge' },
    /*
      절 묶음 — 넓게 뽑아 절 단위로 근거를 합치고, 같은 칸 수를 절 순서로 다시 채운다.
      점수 내는 방식 셋을 나란히 잰다. 어느 쪽이 맞는지는 자료가 정한다(CLAUDE.md §6).
    */
    { label: '+ 절 묶음(합)', config: { ...base, useCode: true, useKeyword: true, useVector: true, useRerank: false }, section: 'sum' },
    { label: '+ 절 묶음(최대)', config: { ...base, useCode: true, useKeyword: true, useVector: true, useRerank: false }, section: 'max' },
    { label: '+ 절 묶음(상위3)', config: { ...base, useCode: true, useKeyword: true, useVector: true, useRerank: false }, section: 'top3' },
    // 더 넓게 훑으면 밀려 있던 절이 더 걸리는가
    { label: '+ 절 묶음 넓게(600)', config: { ...base, useCode: true, useKeyword: true, useVector: true, useRerank: false }, section: 'max', pool: 600 },
    // 절로 살려 낸 뒤 LLM 이 순서를 다듬으면 담당자가 보는 상위 5건이 좋아지는가.
    // 사건당 호출 1회라 비용이 작다
    { label: '+ 절 묶음 + 리랭킹', config: { ...base, useCode: true, useKeyword: true, useVector: true, useRerank: true }, section: 'max' },
    /*
      넓게 잡아 LLM 이 좁힌다 (담당자 요청)

      위 행에서 LLM 은 RRF 가 고른 20건의 **순서만** 바꾼다. 여기서는 50건을 보여 주고
      그중 무엇을 남길지 고르게 한다 — 좁히는 판단 자체가 LLM 으로 넘어간다.
      제시 건수는 똑같이 20건으로 잘라 다른 행과 나란히 견준다.
    */
    { label: '+ 절 묶음 + LLM이 50→20', config: { ...base, useCode: true, useKeyword: true, useVector: true, useRerank: true }, section: 'max', pool: 600, rerankPool: 50 },
    { label: '+ 리랭킹', config: { ...base, useCode: true, useKeyword: true, useVector: true, useRerank: true } },
  ];
  return all.filter((r) => !noLlm || !r.config.useRerank);
}

async function loadCase(caseId: number): Promise<MatchInput> {
  const db = getDb();
  const [ev] = await db<{
    id: number; item_name: string | null; narrative: string;
    keywords: string[]; embedding: string | null;
  }[]>`
    select id, item_name, narrative, keywords, embedding::text
    from public.case_event where id = ${caseId}
  `;
  if (!ev) throw new Error(`사건 ${caseId} 이 없습니다.`);

  const tags = await db<{ axis: string; code: string }[]>`
    select axis, code from public.case_tag
    where case_id = ${caseId} and review_status <> 'rejected'
  `;
  const standardIds = await standardsForCase(caseId);

  return {
    caseId: ev.id,
    itemName: ev.item_name,
    narrative: ev.narrative,
    hfCodes: tags.filter((t) => t.axis === 'HF').map((t) => t.code),
    dtCodes: tags.filter((t) => t.axis === 'DT').map((t) => t.code),
    keywords: ev.keywords ?? [],
    embedding: ev.embedding ? JSON.parse(ev.embedding) : null,
    standardIds: standardIds.length ? standardIds : null,
  };
}

/**
 * 정답셋의 (기준명, 조항번호)를 실제 clause id 로 옮긴다.
 *
 * 하위 조항까지 정답으로 친다 — 계위가 다르기 때문이다 (2026-09-04 수정)
 *   담당자는 사고조사에서 **절 단위**로 적는다. "KC 60335-1 절 15 내습성",
 *   "절 16 누설전류 및 절연내력" 처럼. 그런데 우리 색인은 그 아래 조항 단위다
 *   (15.1, 15.1.1, 15.3 …). IEC 계열에서 절 자체는 제목만 있는 껍데기다 —
 *   실제로 재 보니 절 15 의 본문이 3자, 절 16 이 11자였다.
 *
 *   정확히 일치하는 것만 정답으로 치면, 시스템이 15.3 을 옳게 찾아도 오답이 된다.
 *   껍데기 조항은 본문이 없어 코드도 임베딩도 붙지 않으므로 애초에 검색될 수 없다.
 *   그 상태로 잰 재현율은 시스템의 성능이 아니라 계위 차이를 잰 것이다.
 *
 *   그래서 "절 15" 를 정답으로 적었으면 15 와 그 아래(15.1, 15.1.1 …)를 모두
 *   정답으로 본다. 담당자가 "내습성을 보라"고 한 뜻에 맞는 해석이다.
 *
 *   반대로 넓히지는 않는다 — 15 를 지목했는데 14 나 16 을 찾은 것은 오답이다.
 */
async function resolveExpected(
  expected: Array<{ standard: string; marker: string; part?: string }>,
): Promise<Set<number>> {
  const db = getDb();
  const ids = new Set<number>();
  for (const e of expected) {
    const rows = await db<{ id: number }[]>`
      select c.id from public.clause c
      join public.standard s on s.id = c.standard_id
      where s.is_current
        and s.display_name ilike ${'%' + e.standard + '%'}
        -- 절 자체와 그 아래 조항까지. "15" 는 15 와 15.x 를 뜻하고,
        -- "15." 로 시작하는 것만 잡으므로 150 이나 15A 는 걸리지 않는다
        and (c.marker = ${e.marker} or c.marker like ${e.marker + '.%'})
        ${e.part ? db`and c.part = ${e.part}` : db``}
    `;
    if (rows.length === 0) {
      console.warn(`  경고: 정답 조항을 찾지 못했습니다 — ${e.standard} ${e.marker}`);
    }
    // postgres.js 는 bigint 를 문자열로 준다. 후보 쪽 clauseId 는 숫자이므로
    // 여기서 씻지 않으면 Set 대조가 전부 빗나가 재현율이 늘 0 으로 나온다.
    for (const r of rows) ids.add(Number(r.id));
  }
  return ids;
}

function measure(
  label: string,
  returned: number[],
  expected: Set<number>,
  k: number,
): Metrics {
  const found = returned.filter((id) => expected.has(id)).length;
  const inTopK = returned.slice(0, k).filter((id) => expected.has(id)).length;
  return {
    label,
    // 재현율 — 담당자가 실제 의뢰했을 시험 중 시스템이 제시한 비율
    recall: expected.size ? found / expected.size : 0,
    // 오탐률 — 제시했으나 정답이 아닌 비율. 이게 급증하면 담당자가 목록을 안 믿는다
    falsePositiveRate: returned.length ? (returned.length - found) / returned.length : 0,
    // 상위 k건 내 정답 포함률 — 리랭킹의 효과가 가장 잘 드러나는 지표
    hitAtK: expected.size ? inTopK / Math.min(k, expected.size) : 0,
    returned: returned.length,
    expected: expected.size,
    found,
  };
}

async function runCase(
  caseId: number,
  expected: Set<number>,
  k: number,
  base: MatchConfig,
): Promise<Metrics[]> {
  const input = await loadCase(caseId);
  if (!input.standardIds?.length) {
    console.warn(`  사건 ${caseId}: 품목에 대응하는 기준을 찾지 못해 건너뜁니다(SCOPE_UNRESOLVED).`);
    return [];
  }

  const out: Metrics[] = [];
  for (const { label, config, bridge, section, pool, rerankPool } of configs(base)) {
    let runInput = input;
    let candidates: Candidate[];

    if (section) {
      /*
        넓게 뽑은 뒤 절로 묶는다. 넓게 뽑는 것 자체가 개선이 아니어야 하므로
        마지막에 같은 칸 수(candidateCount)로 잘라 다른 행과 나란히 견준다.
      */
      const wide = await searchCandidates(input, { ...config, candidateCount: pool ?? SECTION_POOL });
      /*
        LLM 에게 좁히는 일을 맡길 때는 여기서 더 많이 남긴다.

        rerankPool 이 없으면 RRF 점수가 고른 20건을 LLM 이 받아 순서만 바꾼다.
        있으면 LLM 이 그만큼을 보고 무엇을 버릴지 정한다 — 좁히는 판단이 LLM 으로 넘어간다.
        어느 쪽이든 마지막에 같은 칸 수로 잘라야 다른 행과 나란히 견줄 수 있다.
      */
      candidates = flattenSections(groupBySection(wide, section), rerankPool ?? config.candidateCount);
    } else if (bridge) {
      const est = await withEstimatedCauses(input);
      if (bridge === 'replace') {
        if (est.candidates.length) {
          console.log(`  원인 다리: ${est.candidates.map((c) => `${c.nameKo ?? c.hfCode}(${c.support}건)`).join(' · ')}`);
        } else if (est.skipped) {
          console.log('  원인 다리: 원인이 이미 확정된 사건이라 건너뜁니다');
        } else {
          console.log('  원인 다리: 이 피해유형에 담긴 원인 후보가 없습니다');
        }
      }
      runInput = est.input;
      candidates = bridge === 'replace'
        ? await searchCandidates(runInput, config)
        // 병합: 결과로 찾은 것과 원인으로 찾은 것이 같은 칸 수를 번갈아 나눠 쓴다.
        // 후보를 늘려 재현율을 올리는 것이 아님을 분명히 하려고 limit 을 그대로 둔다
        : mergeByRank(
            await searchCandidates(input, config),
            est.candidates.length ? await searchCandidates(est.input, config) : [],
            config.candidateCount,
          );
    } else {
      candidates = await searchCandidates(runInput, config);
    }

    if (config.useRerank && candidates.length > 1) {
      const cfg = openaiConfig();
      const scores = await rerankCandidates(
        { itemName: runInput.itemName, narrative: runInput.narrative, hfCodes: runInput.hfCodes, dtCodes: runInput.dtCodes },
        candidates.map((c) => ({
          clauseId: c.clauseId, marker: c.marker,
          contextHeader: c.contextHeader, body: c.body, testConditions: c.testConditions,
        })),
        cfg.rerankModel,
      );
      const byId = new Map(scores.map((s) => [s.clause_id, s]));
      candidates = [...candidates].sort(
        (a, b) => (byId.get(b.clauseId)?.relevance ?? -1) - (byId.get(a.clauseId)?.relevance ?? -1),
      );
      // LLM 이 넓은 목록에서 골랐으면 여기서 칸 수를 맞춘다. 자르지 않으면
      // 제시 건수가 달라져 다른 행과 견줄 수 없다
      if (rerankPool) candidates = candidates.slice(0, config.candidateCount);
    }

    out.push(measure(label, candidates.map((c) => c.clauseId), expected, k));
  }
  return out;
}

function printTable(rows: Metrics[]) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log('');
  console.log('구성                    재현율    오탐률   상위k포함률   제시  정답  적중');
  console.log('─'.repeat(76));
  for (const r of rows) {
    console.log(
      r.label.padEnd(22),
      pct(r.recall).padStart(6),
      pct(r.falsePositiveRate).padStart(8),
      pct(r.hitAtK).padStart(11),
      String(r.returned).padStart(6),
      String(r.expected).padStart(5),
      String(r.found).padStart(5),
    );
  }
}

/** 여러 사건의 지표를 구성별로 평균한다 */
function average(all: Metrics[][]): Metrics[] {
  if (all.length === 0) return [];
  const n = all.length;
  return all[0].map((_, i) => {
    const group = all.map((m) => m[i]);
    return {
      label: group[0].label,
      recall: group.reduce((s, m) => s + m.recall, 0) / n,
      falsePositiveRate: group.reduce((s, m) => s + m.falsePositiveRate, 0) / n,
      hitAtK: group.reduce((s, m) => s + m.hitAtK, 0) / n,
      returned: Math.round(group.reduce((s, m) => s + m.returned, 0) / n),
      expected: Math.round(group.reduce((s, m) => s + m.expected, 0) / n),
      found: Math.round(group.reduce((s, m) => s + m.found, 0) / n),
    };
  });
}

async function main() {
  const k = Number(argValue('--k') ?? '5');
  const onlyCase = argValue('--case') ? Number(argValue('--case')) : null;
  const t = tuning();

  const base: MatchConfig = {
    useCode: true, useKeyword: true, useVector: true, useRerank: false,
    candidateCount: Number(argValue('--candidates') ?? '20'),
    rrfK: t.rrfK, wCode: t.weightCode, wCodePartial: t.weightCodePartial,
    // 기존 동작 그대로. --approved-only 로 검수 확정 태그만 쓰는 구성과 비교한다(030)
    requireApprovedTags: process.argv.includes('--approved-only'),
  };

  if (!existsSync(ANSWER_KEY)) {
    console.log('전문가 정답셋이 없습니다:', ANSWER_KEY);
    console.log('');
    console.log('§5.8 의 수치를 내려면 담당자가 시스템 결과를 보기 전에 작성한 정답셋이');
    console.log('있어야 합니다. v0.7 §0.2 는 시스템 결과를 본 뒤의 검토 기록(review_log)을');
    console.log('정답지로 쓰는 것을 평가 설계 오류로 지목했습니다 — 시스템이 제시하지 않은');
    console.log('조항은 정답에 들어갈 수 없어 재현율이 늘 부풀려지기 때문입니다.');
    console.log('');
    console.log('docs/eval/answer-key.example.json 을 복사해 answer-key.json 으로 채우세요.');
    process.exitCode = 1;
    return;
  }

  const key = JSON.parse(readFileSync(ANSWER_KEY, 'utf8')) as AnswerKey;
  // 정답셋의 caseId 는 DB bigint 에서 나와 문자열로 저장돼 있다. Number 로 씻지 않으면
  // --case 가 항상 빈 목록을 돌려준다(전체 실행은 그대로 동작해 드러나지 않던 결함)
  const targets = onlyCase ? key.cases.filter((c) => Number(c.caseId) === onlyCase) : key.cases;
  if (targets.length === 0) throw new Error('정답셋에 해당 사건이 없습니다.');

  console.log(`정답셋 ${targets.length}건 · 상위 ${k}건 기준`);
  console.log(`갈래별 후보 수 ${base.candidateCount} · RRF k=${base.rrfK} · 코드가산 ${base.wCode}`);

  const all: Metrics[][] = [];
  for (const c of targets) {
    console.log(`\n[사건 ${c.caseId}] ${c.note ?? ''}`);
    const expected = await resolveExpected(c.expected);
    const rows = await runCase(c.caseId, expected, k, base);
    if (rows.length === 0) continue;
    printTable(rows);
    all.push(rows);
  }

  if (all.length > 1) {
    console.log(`\n\n=== ${all.length}건 평균 ===`);
    printTable(average(all));
  }

  console.log('');
  console.log('판단 기준 (§5.8)');
  console.log('  재현율이 크게 오르면서 오탐률이 감당할 수준이면 채택합니다.');
  console.log('  오탐이 급증하면 담당자가 목록을 신뢰하지 않게 되므로 재현율만 보고 정하지 않습니다.');
  console.log('  리랭킹은 후보를 늘리지 않으므로 재현율은 그대로이고 상위k포함률만 좋아지는 것이 정상입니다.');
  if (all.length < 20) {
    console.log('');
    console.log(`주의: 사건 ${all.length}건은 통계적 확정이 아니라 예비 관찰입니다(v0.7 §12.3).`);
    console.log('      0B 는 주요 위해유형을 포함한 20~30건 이상을 권고합니다.');
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
