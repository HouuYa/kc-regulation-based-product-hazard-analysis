/**
 * 「검토가 쌓이면 채워지는 표」 세 개의 집계 — 옛 /insights 화면에서 옮겨 왔다
 *
 * 화면(/policy 맨 아래)과 CSV 내보내기가 같은 질의를 쓰도록 src/lib 에 둔다 (CLAUDE.md §9).
 * 세 표는 모두 041_insight_views.sql 의 뷰를 읽는다. 담당자 채택·반려(review_log)가
 * 쌓여야 숫자가 생기는 표라 지금은 빈 칸이 많다 — 비어 있다는 것 자체가 정보다.
 */

import { getDb } from '../db';

export interface GapRow {
  source_type: string; scope_name: string; hf_code: string; dt_code: string;
  case_count: number; analyzed_count: number; candidate_total: number;
  adopted_total: number; rejected_total: number; status: string;
}
export interface CompareRow {
  cited_standard: string; recall_country: string | null; recall_count: number;
  matched_standards: string[] | null; domestic_test_conditions: number; status: string;
}
export interface TestRow {
  clause_id: number; marker: string; standard_name: string;
  requirement_count: number; proposed_count: number;
  adopted_count: number; rejected_count: number; status: string;
}

export async function loadInsightTables() {
  const db = getDb();
  const [gapStatus, gapTop, cmpStatus, cmpTop, testStatus, testTop, reviewCount] = await Promise.all([
    db<{ status: string; groups: number; cases: number }[]>`
      select status, count(*)::int as groups, sum(case_count)::int as cases
      from public.insight_standard_gap group by status`,
    db<GapRow[]>`
      select * from public.insight_standard_gap
      -- 사각지대 후보를 먼저, 그다음 검토 대기, 그다음 나머지
      order by (status in ('NO_CANDIDATE','ALL_REJECTED')) desc,
               (status = 'NOT_REVIEWED') desc, case_count desc
      limit 25`,
    db<{ status: string; standards: number; recalls: number }[]>`
      select status, count(*)::int as standards, sum(recall_count)::int as recalls
      from public.insight_standard_comparison group by status`,
    db<CompareRow[]>`
      select * from public.insight_standard_comparison
      order by (status = 'COMPARABLE') desc, (status = 'MATCHED_NO_DATA') desc, recall_count desc
      limit 25`,
    db<{ status: string; methods: number }[]>`
      select status, count(*)::int as methods from public.insight_test_usage group by status`,
    db<TestRow[]>`
      select * from public.insight_test_usage
      order by (status = 'LOW_ADOPTION') desc, proposed_count desc, standard_name, marker
      limit 25`,
    db<{ n: number }[]>`select count(*)::int as n from public.review_log`,
  ]);
  return { gapStatus, gapTop, cmpStatus, cmpTop, testStatus, testTop, reviews: reviewCount[0].n };
}

export type InsightTables = Awaited<ReturnType<typeof loadInsightTables>>;
