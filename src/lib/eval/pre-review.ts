/**
 * 사고 사전 검토 평가 — 같은 사건을 「조사 전」과 「조사 뒤」 두 조건으로 재 본다 (06_02 P0-3)
 *
 * 왜 두 조건인가
 *   접수 양식은 결과 보고서와 같고, 조사 전에는 결과 칸이 비어 있다(06_01). 끝난 보고서의
 *   결과 칸을 가리면(narrative.ts intakePortion) 「조사 전」 문제가 되고, 실제로 한 시험이
 *   정답이 된다. 지금까지의 숫자는 결과 칸을 본 「조사 뒤」 숫자였다 — 둘을 같은 설정으로
 *   나란히 재야 사전 검토가 실제로 얼마나 하는지 안다.
 *
 * 무엇을 재나 (다섯 결과 중 지금 잴 수 있는 것)
 *   1 제품분류   적용 기준을 찾았는가 — 품목명(양식 머리)만 쓰므로 두 조건이 같다
 *   2 HF-DT      조사 전 글로 다시 코드를 붙여, 결과까지 읽고 붙인 코드(case_tag)와 견준다
 *   3 시험 후보  실제로 한 시험을 조항 절에 맞춘 것(병행 점검과 같은 규칙)이 후보에 드는가
 *   4 인증·표시  조사 전 확인 항목은 아직 없다(P1-5) — 재지 않는다
 *   5 닮은 리콜  저장된 임베딩이 전문으로 만든 것이라 조사 전 조건으로는 아직 못 잰다
 *
 * 공정하게 견주려고 정한 것
 *   - 두 조건 모두 같은 검색 설정으로 부른다. 재채점(LLM)·HyDE 는 끈다 — 조건 차이만 보이게.
 *   - 사진 관찰은 넣지 않는다. 사진 판독에는 시험 중 측정값이 섞여 있다(라운드 72).
 *   - 아무것도 저장하지 않는다. case_tag·match_run 을 덮지 않는다(CLAUDE.md §13).
 */
import { getDb } from '../db';
import { intakePortion } from '../second-opinion/narrative';
import { loadApplicableClauses, groupSections, matchPerformedTests } from '../second-opinion/coverage';
import { standardsForCase } from '../cases/resolve-scope';
import { searchCandidates, type MatchInput } from '../search/match';
import { loadCaseInput, defaultMatchConfig } from '../search/run';
import { buildCaseSearchText, type SearchTextVariant } from '../search/search-text';
import { tagCase, toTagRows, type CodebookSnapshot } from '../llm/tagging';
import { embedBatch } from '../llm/client';
import { codeLabelMap } from '../codebook/snapshot';
import { tuning } from '../env';

export interface ConditionResult {
  dtPrimary: string | null;
  hfPrimary: string | null;
  /** 후보 20건이 덮은 정답 절 수 */
  goldSectionsHit: number;
  /** 상위 5건 안에 정답 절이 하나라도 있는가 */
  top5Hit: boolean;
  candidateCount: number;
}

export interface PreReviewCase {
  caseId: number;
  title: string | null;
  /** 결과 칸을 가릴 수 없으면 평가에서 뺀다 */
  skipped: string | null;
  standardsFound: number;
  /** 정답: 실제로 한 시험 수와, 그중 조항 절에 맞춘 것 */
  performedTests: number;
  goldSections: number;
  gold: { dtPrimary: string | null; hfPrimary: string | null };
  pre: ConditionResult | null;
  post: ConditionResult | null;
}

/** 사건마다 가장 최근 병행 점검이 뽑은 「실제로 한 시험」 — 정답 */
async function performedTests(caseId: number): Promise<string[]> {
  const rows = await getDb()<{ label: string }[]>`
    select i.label from public.case_investigation_item i
    where i.item_type = 'TEST_PERFORMED'
      and i.run_id = (select id from public.second_opinion_run where case_id = ${caseId}
                      order by started_at desc, id desc limit 1)
  `;
  return rows.map((r) => r.label);
}

function scoreCandidates(
  candidateIds: number[], clauseToSection: Map<number, string>, gold: Set<string>,
): Pick<ConditionResult, 'goldSectionsHit' | 'top5Hit' | 'candidateCount'> {
  const keys = candidateIds.map((id) => clauseToSection.get(id)).filter((k): k is string => !!k);
  return {
    goldSectionsHit: new Set(keys.filter((k) => gold.has(k))).size,
    top5Hit: keys.slice(0, 5).some((k) => gold.has(k)),
    candidateCount: candidateIds.length,
  };
}

const config = () => defaultMatchConfig({ useRerank: false });

export async function evaluateCase(
  caseId: number, snapshot: CodebookSnapshot,
): Promise<PreReviewCase> {
  const db = getDb();
  const [ev] = await db<{ title: string | null; item_name: string | null; narrative: string }[]>`
    select title, item_name, narrative from public.case_event where id = ${caseId}
  `;
  const tags = await db<{ axis: string; code: string; is_primary: boolean }[]>`
    select axis, code, is_primary from public.case_tag
    where case_id = ${caseId} and review_status <> 'rejected'
  `;
  const goldDt = tags.find((t) => t.axis === 'DT' && t.is_primary)?.code ?? null;
  const goldHf = tags.find((t) => t.axis === 'HF' && t.is_primary)?.code ?? null;

  const standardIds = await standardsForCase(caseId);
  const tests = await performedTests(caseId);
  const base = {
    caseId, title: ev.title, standardsFound: standardIds.length,
    performedTests: tests.length, gold: { dtPrimary: goldDt, hfPrimary: goldHf },
  };

  const intake = intakePortion(ev.narrative);
  if (!intake) return { ...base, skipped: '결과 칸을 가릴 수 없는 양식', goldSections: 0, pre: null, post: null };

  // 정답 절 — 병행 점검이 쓰는 규칙(제목 접두 일치) 그대로
  const { requirement } = await loadApplicableClauses(standardIds);
  const sections = groupSections(requirement);
  const clauseToSection = new Map<number, string>();
  for (const [key, s] of sections) for (const id of s.clauseIds) clauseToSection.set(id, key);
  const gold = new Set(matchPerformedTests(tests, requirement).flatMap((m) => m.sectionKeys));

  if (standardIds.length === 0) {
    return { ...base, skipped: '적용 기준을 찾지 못함', goldSections: gold.size, pre: null, post: null };
  }

  // ── 조사 뒤: 지금 저장된 그대로(전문·저장 태그·저장 임베딩) ──────────────
  const postInput = await loadCaseInput(caseId);
  const postCands = await searchCandidates(postInput, config());
  const post: ConditionResult = {
    dtPrimary: goldDt, hfPrimary: goldHf,
    ...scoreCandidates(postCands.map((c) => c.clauseId), clauseToSection, gold),
  };

  // ── 조사 전: 가린 글로 코드를 다시 붙이고 임베딩을 다시 만든다 (LLM·임베딩 호출) ──
  const tagged = await tagCase({ itemName: ev.item_name, title: ev.title, narrative: intake.text }, snapshot, caseId);
  const rows = toTagRows(tagged);
  const labels = codeLabelMap(snapshot);
  const hf = rows.filter((r) => r.axis === 'HF').map((r) => r.code);
  const dt = rows.filter((r) => r.axis === 'DT').map((r) => r.code);
  const searchText = buildCaseSearchText(
    {
      itemName: ev.item_name, title: ev.title, narrative: intake.text,
      chunkSummary: tagged.output.chunk_summary,
      codeLabels: [...hf, ...dt].map((c) => labels.get(c) ?? c),
    },
    tuning().searchTextVariant as SearchTextVariant,
  );
  const [embedding] = await embedBatch([searchText]);
  const preInput: MatchInput = {
    caseId, itemName: ev.item_name, narrative: intake.text,
    hfCodes: hf, dtCodes: dt, keywords: tagged.output.keywords ?? [], embedding, standardIds,
  };
  const preCands = await searchCandidates(preInput, config());
  const pre: ConditionResult = {
    dtPrimary: rows.find((r) => r.axis === 'DT' && r.is_primary)?.code ?? null,
    hfPrimary: rows.find((r) => r.axis === 'HF' && r.is_primary)?.code ?? null,
    ...scoreCandidates(preCands.map((c) => c.clauseId), clauseToSection, gold),
  };

  return { ...base, skipped: null, goldSections: gold.size, pre, post };
}

/** 대분류 하나의 사고보고서 id — 06_02 은 전기용품부터 한다 */
export async function accidentIdsInGroup(group: string): Promise<number[]> {
  const rows = await getDb()<{ id: number }[]>`
    select e.id::int from public.case_event e
    join public.case_event_group g on g.case_id = e.id
    where e.source_type = 'ACCIDENT' and g.item_group = ${group}
    order by e.id
  `;
  return rows.map((r) => r.id);
}
