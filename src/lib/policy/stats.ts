/**
 * 정책 현황판(/policy) 집계 — 화면과 CSV 내보내기가 같은 숫자를 쓰도록 한 곳에 둔다 (CLAUDE.md §9)
 *
 * 이 파일이 하지 않는 것
 *   결론 문장을 만들지 않는다. "늘었다·위험하다·기준이 없다"는 판단은 담당 부서와
 *   전문가의 몫이다. 여기서는 숫자와 그 숫자의 분모만 낸다.
 *
 * 0건의 뜻을 나눈다 (insights 화면과 같은 원칙)
 *   "국내 유통 0건"은 "국내에 안 들어왔다"가 아니라 "아직 아무도 확인하지 않았다"다.
 *   그래서 모든 비율은 분모와 함께 돌려주고, 화면이 그 둘을 나란히 적는다.
 */

import { getDb } from '../db';
import { classifiedSql } from '../cases/classified';

export interface SourceCoverage {
  source_type: 'ACCIDENT' | 'RECALL_OVERSEAS' | string;
  total: number;
  /** HF 코드가 하나라도 붙은 사건 */
  hf_coded: number;
  /** 코드는 있지만 대표 원인 중 밝혀진 것(HF.UNKNOWN 이 아닌 것)이 하나도 없는 사건 */
  hf_unknown: number;
  /** 품목(적용 기준)이 정해진 사건 */
  scoped: number;
  /** 품목이 분류된 사건 — 담당자 지정·자동 판정·원본 GPC 중 하나(lib/cases/classified.ts). 2026-10-07 */
  classified: number;
  /** 담당자가 원문(추출 결과)을 확인한 사건. 사고보고서에서만 뜻이 있다 */
  confirmed: number;
  /** 발생일이 비어 있는 사건 */
  no_date: number;
  /** 조항 후보 검색(match_run)을 한 번이라도 돌린 사건 */
  analyzed: number;
  /** 병행 점검을 한 번이라도 돌린 사건 */
  second_opinion: number;
  /** 담당자 채택·반려 기록(review_log) 수 */
  reviews: number;
}

export interface CodeCount {
  axis: 'HF' | 'DT';
  code: string;
  name_ko: string | null;
  /** HF 의 확인 경로 (codebook.hf_route). DT 는 null */
  route: 'TEST' | 'LEGAL' | 'GAP' | 'OTHER' | null;
  /** 이 코드를 대표 코드로 가진 사건 수 */
  cases: number;
  /** 그중 Recall Hub 관리자가 분류한 것(review_status='approved') */
  approved: number;
}

export interface CrossCount {
  key: string;
  code: string;
  cases: number;
}

export interface FindingKind {
  output_kind: 'TEST_ITEM' | 'CERT_MARKING_CHECK' | 'REFERENCE' | 'POLICY_SIGNAL' | string;
  rows: number;
  cases: number;
}

export interface PolicySignal {
  case_id: number;
  title: string | null;
  rationale: string;
  evidence: string | null;
  needs_expert_confirm: boolean;
}

/**
 * 사건별 "가장 최근 병행 점검 실행"만 고른다.
 *
 * second_opinion_run 은 덮어쓰지 않고 쌓는다(070) — 같은 사건을 다시 돌리면 소견이
 * 한 벌 더 생긴다. 누적으로 세면 2026-10-07 기준 6,255행인데 최신 실행만 세면
 * 1,496행이다. 재실행 횟수가 위해 비중으로 둔갑하지 않게 최신만 센다.
 */
const latestRun = (db: ReturnType<typeof getDb>) => db`
  latest as (
    select distinct on (case_id) id, case_id
    from public.second_opinion_run
    order by case_id, started_at desc, id desc
  )
`;

export async function loadPolicyStats() {
  const db = getDb();

  const [coverage, domestic, codes, byCountry, byMonth, kinds, kindReviews, signals, standards, codebook] =
    await Promise.all([
      db<SourceCoverage[]>`
        select
          e.source_type,
          count(*)::int as total,
          count(*) filter (where exists (
            select 1 from public.case_tag t where t.case_id = e.id and t.axis = 'HF'))::int as hf_coded,
          count(*) filter (where exists (
            select 1 from public.case_tag t where t.case_id = e.id and t.axis = 'HF')
            and not exists (
            select 1 from public.case_tag t where t.case_id = e.id and t.axis = 'HF'
              and t.is_primary and t.code <> 'HF.UNKNOWN'))::int as hf_unknown,
          count(*) filter (where e.product_scope_id is not null)::int as scoped,
          count(*) filter (where ${classifiedSql('e')})::int as classified,
          count(*) filter (where e.is_confirmed)::int as confirmed,
          count(*) filter (where e.occurred_on is null)::int as no_date,
          count(*) filter (where exists (
            select 1 from public.match_run r where r.case_id = e.id))::int as analyzed,
          count(*) filter (where exists (
            select 1 from public.second_opinion_run s where s.case_id = e.id))::int as second_opinion,
          (select count(*)::int from public.review_log rl
             join public.match_result mr on mr.id = rl.match_result_id
             join public.match_run mrun on mrun.id = mr.run_id
             join public.case_event ce on ce.id = mrun.case_id
            where ce.source_type = e.source_type) as reviews
        from public.case_event e
        where e.source_type in ('ACCIDENT', 'RECALL_OVERSEAS')
        group by e.source_type`,
      // 국내 유통 확인 — UNCHECKED 가 아닌 것만 "확인함"으로 센다
      db<{ total: number; checked: number }[]>`
        select count(*)::int as total,
               count(*) filter (where domestic_check is not null and domestic_check <> 'UNCHECKED')::int as checked
        from public.recall_cache where origin = 'OVERSEAS'`,
      // 대표 코드 분포. 라벨은 활성 코드북 판에서 가져온다
      db<CodeCount[]>`
        with av as (select id from codebook.version where status = 'active')
        select t.axis, t.code,
               coalesce(d.name_ko, h.name_ko) as name_ko,
               r.route,
               count(distinct t.case_id)::int as cases,
               count(distinct t.case_id) filter (where t.review_status = 'approved')::int as approved
        from public.case_tag t
        join public.case_event e on e.id = t.case_id and e.source_type = 'RECALL_OVERSEAS'
        left join codebook.damage_type d
          on t.axis = 'DT' and d.code = t.code and d.version_id = (select id from av)
        left join codebook.hazard_factor h
          on t.axis = 'HF' and h.code = t.code and h.version_id = (select id from av)
        left join codebook.hf_route r on t.axis = 'HF' and r.code = t.code
        where t.is_primary
        group by t.axis, t.code, coalesce(d.name_ko, h.name_ko), r.route
        order by t.axis, cases desc, t.code`,
      db<CrossCount[]>`
        select coalesce(nullif(e.raw_fields->>'country', ''), '(국가 미상)') as key,
               t.code, count(distinct e.id)::int as cases
        from public.case_event e
        join public.case_tag t on t.case_id = e.id and t.axis = 'DT' and t.is_primary
        where e.source_type = 'RECALL_OVERSEAS'
        group by 1, 2`,
      db<CrossCount[]>`
        select coalesce(to_char(date_trunc('month', e.occurred_on), 'YYYY-MM'), '(날짜 없음)') as key,
               t.code, count(distinct e.id)::int as cases
        from public.case_event e
        join public.case_tag t on t.case_id = e.id and t.axis = 'DT' and t.is_primary
        where e.source_type = 'RECALL_OVERSEAS'
        group by 1, 2`,
      db<FindingKind[]>`
        with ${latestRun(db)}
        select f.output_kind, count(*)::int as rows, count(distinct f.case_id)::int as cases
        from public.second_opinion_finding f join latest l on l.id = f.run_id
        group by f.output_kind`,
      // 최신 실행 소견 중 담당자가 판정한 것 — 이 계층의 유일한 성적표다(070)
      db<{ reviewed: number; total_rows: number; runs: number }[]>`
        with ${latestRun(db)}
        select
          (select count(distinct f.id)::int from public.second_opinion_finding f
             join latest l on l.id = f.run_id
             join public.second_opinion_review rv on rv.finding_id = f.id) as reviewed,
          (select count(*)::int from public.second_opinion_finding) as total_rows,
          (select count(*)::int from public.second_opinion_run) as runs`,
      db<PolicySignal[]>`
        with ${latestRun(db)}
        select f.case_id::int as case_id, e.title, f.rationale,
               left(f.evidence_span, 160) as evidence, f.needs_expert_confirm
        from public.second_opinion_finding f
        join latest l on l.id = f.run_id
        join public.case_event e on e.id = f.case_id
        where f.output_kind = 'POLICY_SIGNAL'
        order by f.case_id`,
      // 해외 근거 표준 ↔ 국내 기준 번호 연결 (리콜 건 단위)
      db<{ total: number; cited: number; matched: number }[]>`
        select count(*)::int as total,
               count(*) filter (where cardinality(cited_standards) > 0)::int as cited,
               count(*) filter (where cardinality(matched_standard_ids) > 0)::int as matched
        from public.recall_cache where origin = 'OVERSEAS'`,
      db<{ version: string | null }[]>`select version from codebook.version where status = 'active' limit 1`,
    ]);

  return {
    coverage,
    domestic: domestic[0],
    codes,
    byCountry,
    byMonth,
    kinds,
    kindReviews: kindReviews[0],
    signals,
    standards: standards[0],
    codebookVersion: codebook[0]?.version ?? null,
  };
}

export type PolicyStats = Awaited<ReturnType<typeof loadPolicyStats>>;

/** 행(국가·월) × 열(대표 피해유형) 표. 열은 전체 상위 N개 + 나머지를 「그 외」로 묶는다 */
export interface CrossTable {
  columns: string[];
  rows: Array<{ key: string; total: number; cells: number[]; other: number }>;
}

export function crossTable(
  data: CrossCount[], columns: string[], opts: { topRows?: number; sortBy: 'total' | 'key' },
): CrossTable {
  const byKey = new Map<string, Map<string, number>>();
  for (const r of data) {
    const m = byKey.get(r.key) ?? new Map<string, number>();
    m.set(r.code, (m.get(r.code) ?? 0) + r.cases);
    byKey.set(r.key, m);
  }
  let rows = [...byKey.entries()].map(([key, m]) => {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const cells = columns.map((c) => m.get(c) ?? 0);
    return { key, total, cells, other: total - cells.reduce((a, b) => a + b, 0) };
  });
  rows = opts.sortBy === 'total'
    ? rows.sort((a, b) => b.total - a.total)
    : rows.sort((a, b) => a.key.localeCompare(b.key));
  return { columns, rows: opts.topRows ? rows.slice(0, opts.topRows) : rows };
}

/** 대표 피해유형 상위 N개 코드 */
export function topDt(codes: CodeCount[], n: number): string[] {
  return codes.filter((c) => c.axis === 'DT').slice(0, n).map((c) => c.code);
}
