/**
 * 매칭 실행 (설계문서 §5.1 전체 흐름 / v0.7 §7.1 처리 순서)
 *
 *   ① 코드 매칭 ② 키워드 매칭 ③ 의미 매칭  →  ④ 순위 합산
 *   →  ⑤ 관계 확장 (성능요건 → 시험방법)
 *   →  ⑥ 정밀 재채점(선택)  →  ⑦ 저장
 *
 * 판단은 DB 가 한다 (§1.1 원칙 2)
 *   ①~④ 는 SQL 함수 하나가 계산한다. 애플리케이션은 그 함수를 부르고 결과를 저장할 뿐,
 *   어떤 조항이 걸리는지를 스스로 정하지 않는다. 같은 입력에 항상 같은 출력이 나오고
 *   근거를 행 단위로 제시할 수 있는 이유가 이것이다.
 *
 * 관계 확장이 별도 단계인 이유 (v0.7 §5.3)
 *   시험방법 조항은 직접 검색 대상이 아니다. 성능요건에서 이동해 온다.
 *   "4.3.3 안정성"이 걸리면 그 조항이 지목하는 "5.9.2 안정성 시험"을 따라간다.
 *   시험방법을 직접 검색하면 사고 서술과 문체가 달라 잘 걸리지도 않는다.
 *
 * 결과 0건을 버리지 않는다 (§2.3 결정 A)
 *   "대응 조항이 없음"이 그 자체로 산출물이다. 다만 v0.7 §7.8 이 지적하듯
 *   0건을 곧바로 사각지대로 집계하면 데이터 누락을 정책 신호로 오인한다.
 *   그래서 0건의 사유를 구분해 돌려준다.
 */

import { getDb, toVectorLiteral } from '../db';

/** 검색 0건일 때의 사유 (v0.7 §7.8) */
export type EmptyReason =
  /** 품목·적용기준 미확정 — 사각지대 집계 제외 */
  | 'SCOPE_UNRESOLVED'
  /** 적용기준 원문·버전 누락 — 제외 */
  | 'STANDARD_DATA_MISSING'
  /** 관련 조항이 아직 태깅되지 않음 — 제외 */
  | 'TAGGING_INCOMPLETE'
  /** 성능요건은 있으나 시험방법 연결 누락 — 데이터 품질 이슈 */
  | 'CLAUSE_LINK_MISSING'
  /** 완전성 확인 후에도 관련 조항 없음 — 전문가 검토 대상 */
  | 'NO_RELEVANT_CLAUSE';

/** 증거수준 (v0.7 §7.7) */
export type EvidenceLevel = 'A' | 'B' | 'C' | 'X';

export interface MatchConfig {
  useCode: boolean;
  useKeyword: boolean;
  useVector: boolean;
  useRerank: boolean;
  candidateCount: number;
  rrfK: number;
  wCode: number;
  wCodePartial: number;
}

export interface Candidate {
  clauseId: number;
  marker: string;
  part: string | null;
  breadcrumbPath: string | null;
  body: string;
  contextHeader: string | null;
  standardName: string | null;
  score: number;
  matchPath: 'CODE' | 'CODE-PARTIAL' | 'HYBRID' | 'FALLBACK';
  rankCode: number | null;
  rankKeyword: number | null;
  rankVector: number | null;
  /** 이 성능요건이 지목하는 시험방법 조항들 (관계 확장 결과) */
  testMethods: Array<{ clauseId: number | null; marker: string; body: string | null; evidence: string | null }>;
  testConditions: string[];
  /** 검수 상태를 반영한 증거수준 */
  evidenceLevel: EvidenceLevel;
  rerankScore?: number;
  rerankReason?: string;
}

export interface MatchInput {
  caseId: number;
  itemName: string | null;
  narrative: string;
  hfCodes: string[];
  dtCodes: string[];
  keywords: string[];
  embedding: number[] | null;
  /** 품목으로 좁힌 기준 목록. 비면 전 기준 검색이 되므로 주의 (v0.7 §3.2) */
  standardIds: number[] | null;
}

export interface MatchOutcome {
  runId: number;
  candidates: Candidate[];
  emptyReason: EmptyReason | null;
}

/**
 * 증거수준 판정 (v0.7 §7.7)
 *
 * A  품목·기준 확정 + 검수 태그 일치 + 조항관계 검수완료 → 구조화 근거 강함
 * B  품목 확정 + 자동 미검수 태그 또는 어휘·의미 복수 일치 → 담당자 확인 필요
 * C  미태깅 상태의 의미검색 단독 → 탐색 후보
 * X  품목·기준 미확정, 원천 누락 → 분석 보류
 */
function evidenceLevelOf(
  matchPath: Candidate['matchPath'],
  hasReviewedTag: boolean,
  scopeResolved: boolean,
): EvidenceLevel {
  if (!scopeResolved) return 'X';
  if (matchPath === 'FALLBACK') return 'C';
  if ((matchPath === 'CODE' || matchPath === 'CODE-PARTIAL') && hasReviewedTag) return 'A';
  return 'B';
}

interface SearchRow {
  clause_id: number;
  score: string;
  match_path: Candidate['matchPath'];
  rank_code: number | null;
  rank_keyword: number | null;
  rank_vector: number | null;
  marker: string;
  part: string | null;
  breadcrumb_path: string | null;
  body: string;
  context_header: string | null;
  standard_name: string | null;
  has_reviewed_tag: boolean;
  test_conditions: string[] | null;
  test_methods: Array<{ clause_id: number | null; marker: string; body: string | null; evidence: string | null }> | null;
}

/**
 * 검색 + 관계 확장. 리랭킹과 저장은 호출자가 이어서 한다.
 *
 * 한 번의 SQL 왕복으로 끝내는 이유(§5.5): 세 갈래를 애플리케이션에서 합치면
 * 왕복이 늘고 규칙이 흩어진다. 매칭 규칙이 한 곳에 모여 있어야 감사·수정이 쉽다.
 */
export async function searchCandidates(
  input: MatchInput,
  config: MatchConfig,
): Promise<Candidate[]> {
  const db = getDb();
  const scopeResolved = (input.standardIds?.length ?? 0) > 0;

  const rows = await db<SearchRow[]>`
    with hits as (
      select * from public.clause_hybrid_search(
        ${input.narrative},
        ${input.keywords}::text[],
        ${input.embedding ? toVectorLiteral(input.embedding) : null}::extensions.vector(1536),
        ${input.hfCodes}::text[],
        ${input.dtCodes}::text[],
        ${input.standardIds}::bigint[],
        ${config.candidateCount},
        ${config.useCode}, ${config.useKeyword}, ${config.useVector},
        ${config.rrfK}, ${config.wCode}, ${config.wCodePartial}
      )
    )
    select
      h.clause_id, h.score, h.match_path, h.rank_code, h.rank_keyword, h.rank_vector,
      c.marker, c.part, c.breadcrumb_path, c.body, c.context_header,
      s.display_name as standard_name,
      exists (
        select 1 from public.clause_tag t
        where t.clause_id = c.id and t.review_status = 'approved'
      ) as has_reviewed_tag,
      (select array_agg(tc.item_name || ' ' || coalesce(tc.allowance_raw, '') order by tc.id)
       from public.test_condition tc where tc.clause_id = c.id) as test_conditions,
      -- 관계 확장: 성능요건 → 시험방법 (v0.7 §5.3 REQUIREMENT_TESTED_BY)
      (select json_agg(json_build_object(
                'clause_id', l.to_clause_id,
                'marker',    l.to_marker,
                'body',      tm.body,
                'evidence',  l.evidence_span))
       from public.clause_link l
       left join public.clause tm on tm.id = l.to_clause_id
       where l.from_clause_id = c.id and l.link_type = 'TEST_METHOD') as test_methods
    from hits h
    join public.clause c   on c.id = h.clause_id
    join public.standard s on s.id = c.standard_id
    order by h.score desc
  `;

  return rows.map((r) => ({
    clauseId: r.clause_id,
    marker: r.marker,
    part: r.part,
    breadcrumbPath: r.breadcrumb_path,
    body: r.body,
    contextHeader: r.context_header,
    standardName: r.standard_name,
    score: Number(r.score),
    matchPath: r.match_path,
    rankCode: r.rank_code,
    rankKeyword: r.rank_keyword,
    rankVector: r.rank_vector,
    // SQL 은 snake_case 로 돌려주므로 여기서 한 번만 바꾼다
    testMethods: (r.test_methods ?? []).map((t) => ({
      clauseId: t.clause_id,
      marker: t.marker,
      body: t.body,
      evidence: t.evidence,
    })),
    testConditions: r.test_conditions ?? [],
    evidenceLevel: evidenceLevelOf(r.match_path, r.has_reviewed_tag, scopeResolved),
  }));
}

/**
 * 0건의 사유를 가린다 (v0.7 §7.8)
 *
 * "검색 0건 자체를 기준 사각지대로 집계하지 않는다."
 * 범위 미확정·미태깅·원문 누락과 진짜 사각지대 후보를 구분해야
 * 데이터 누락을 정책 신호로 오인하지 않는다.
 */
export async function diagnoseEmpty(input: MatchInput): Promise<EmptyReason> {
  const db = getDb();

  if (!input.standardIds?.length) return 'SCOPE_UNRESOLVED';

  const [scope] = await db<{ clauses: number; tagged: number; linked: number }[]>`
    select
      count(*)::int as clauses,
      count(*) filter (where exists (
        select 1 from public.clause_tag t where t.clause_id = c.id))::int as tagged,
      count(*) filter (where exists (
        select 1 from public.clause_link l
        where l.from_clause_id = c.id and l.link_type = 'TEST_METHOD'))::int as linked
    from public.clause c
    where c.standard_id = any (${input.standardIds}::bigint[])
  `;

  if (!scope || scope.clauses === 0) return 'STANDARD_DATA_MISSING';
  if (scope.tagged === 0) return 'TAGGING_INCOMPLETE';
  if (scope.linked === 0) return 'CLAUSE_LINK_MISSING';
  return 'NO_RELEVANT_CLAUSE';
}

/** 실행과 결과를 저장한다. 재실행 시 덮어쓰지 않고 새 run 을 쌓는다(§2.2) */
export async function persistRun(
  input: MatchInput,
  config: MatchConfig,
  candidates: Candidate[],
  meta: { embeddingModel: string | null; rerankModel: string | null; shortlist: number },
): Promise<number> {
  const db = getDb();

  const [run] = await db<{ id: number }[]>`
    insert into public.match_run
      (case_id, use_code, use_keyword, use_vector, use_rerank,
       rrf_k, w_code, w_code_partial, candidate_count,
       embedding_model, rerank_model, result_count,
       queried_hf_codes, queried_dt_codes, finished_at)
    values (${input.caseId}, ${config.useCode}, ${config.useKeyword}, ${config.useVector},
            ${config.useRerank}, ${config.rrfK}, ${config.wCode}, ${config.wCodePartial},
            ${config.candidateCount}, ${meta.embeddingModel}, ${meta.rerankModel},
            ${candidates.length}, ${input.hfCodes}::text[], ${input.dtCodes}::text[], now())
    returning id
  `;

  if (candidates.length > 0) {
    // 탈락 후보도 저장한다 — 상위 N 건만 남기지 않는다(§5.6.3)
    const rows = candidates.map((c, i) => ({
      run_id: run.id,
      clause_id: c.clauseId,
      search_score: c.score,
      match_path: c.matchPath,
      rank_code: c.rankCode,
      rank_keyword: c.rankKeyword,
      rank_vector: c.rankVector,
      rerank_score: c.rerankScore ?? null,
      rerank_reason: c.rerankReason ?? null,
      rerank_model: c.rerankScore != null ? meta.rerankModel : null,
      final_rank: i + 1,
      is_shortlisted: i < meta.shortlist,
    }));
    await db`insert into public.match_result ${db(
      rows as never,
      'run_id', 'clause_id', 'search_score', 'match_path',
      'rank_code', 'rank_keyword', 'rank_vector',
      'rerank_score', 'rerank_reason', 'rerank_model', 'final_rank', 'is_shortlisted',
    )}`;
  }

  return run.id;
}
