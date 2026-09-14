import { getDb } from '@/lib/db';
import { parseBoard, type BoardParams } from '@/components/Board';

/**
 * 리콜 화면 — 현황/처리할 것 두 페이지가 함께 쓰는 조회·상수 (2026-09-14)
 *
 * accidents/data.ts 와 같은 이유로 뽑았다 — `/recalls`(처리할 것, 기본)와
 * `/recalls/status`(현황)가 같은 집계·목록 조회를 쓴다(CLAUDE.md §9).
 */

export interface Summary {
  overseas: number;
  domestic: number;
  cases: number;
  coded: number;
  embedded: number;
  analyzed: number;
  uncheckedDistribution: number;
}

export interface RecallRow {
  id: number;
  origin: string;
  title: string | null;
  brand: string | null;
  recall_country: string | null;
  hazard_type: string | null;
  published_on: string | null;
  fetched_at: string | null;
  domestic_check: string | null;
  detail_url: string | null;
  case_id: number | null;
  tag_count: number;
  embedded: boolean | null;
  embedding_pending: boolean | null;
  run_count: number;
  last_results: number | null;
  /** 대분류 — 전기용품·생활용품·어린이제품. 사전에 없는 이름이면 null(화면에서 「기타」) */
  item_group: string | null;
}

export const DISTRIBUTION_LABEL: Record<string, string> = {
  UNCHECKED: '확인 안 함',
  DISTRIBUTED: '국내에도 유통됨',
  NOT_DISTRIBUTED: '국내 유통 없음',
  UNKNOWN: '확인했으나 알 수 없음',
};

/** 정렬 가능한 열. 주소줄에서 오는 값이므로 반드시 이 목록 안에서만 고른다 */
const SORTS: Record<string, string> = {
  published_on: 'rc.published_on',
  fetched_at: 'rc.fetched_at',
  title: 'rc.title',
  domestic_check: 'rc.domestic_check',
};

export async function load(params: BoardParams) {
  const db = getDb();
  const { q, per, offset, sort, dir, page } = parseBoard(params, 'published_on');
  const orderBy = SORTS[sort] ?? SORTS.published_on;
  const origin = params.origin ?? '';
  const check = params.check ?? '';
  const group = params.group ?? '';

  const summaryQuery = db<Summary[]>`
    select
      (select count(*)::int from public.case_event where source_type = 'RECALL_OVERSEAS') as overseas,
      (select count(*)::int from public.case_event where source_type = 'RECALL_DOMESTIC') as domestic,
      (select count(*)::int from public.case_event
        where source_type in ('RECALL_OVERSEAS', 'RECALL_DOMESTIC'))                      as cases,
      (select count(distinct t.case_id)::int from public.case_tag t
        join public.case_event e on e.id = t.case_id
        where e.source_type in ('RECALL_OVERSEAS', 'RECALL_DOMESTIC'))                    as coded,
      (select count(*)::int from public.case_event
        where source_type in ('RECALL_OVERSEAS', 'RECALL_DOMESTIC')
          and embedding is not null)                                                      as embedded,
      (select count(distinct r.case_id)::int from public.match_run r
        join public.case_event e on e.id = r.case_id
        where e.source_type in ('RECALL_OVERSEAS', 'RECALL_DOMESTIC'))                    as analyzed,
      (select count(*)::int from public.recall_cache
        where coalesce(domestic_check, 'UNCHECKED') = 'UNCHECKED')                        as "uncheckedDistribution"
  `;

  /*
    대분류로 걸러 보기 (담당자 요청, 2026-09-09)

    "검토 시 전기/생활/어린이는 대분류로 무조건 구분하여 정렬될 수 있도록.
     가능하다면 해외 리콜도 그렇게 해 주고, 애매하면 기타로 빼면 됨."

    대분류는 case_event_group 뷰가 계산한다(059) — 서류의 제품명을 품목 용어
    사전으로 옮겨 안전기준의 대분류를 얻는다. 사전에 없는 이름은 행이 없으므로
    「기타」로 다룬다. 지금 해외 리콜 2,338건 중 765건(33%)에 대분류가 붙는다.
  */
  const where = db`
    where true
      ${q ? db`and (rc.title ilike ${'%' + q + '%'} or rc.brand ilike ${'%' + q + '%'}
                    or rc.hazard_type ilike ${'%' + q + '%'}
                    or rc.recall_country ilike ${'%' + q + '%'})` : db``}
      ${origin ? db`and rc.origin = ${origin}` : db``}
      ${check ? db`and coalesce(rc.domestic_check, 'UNCHECKED') = ${check}` : db``}
      ${group === '기타' ? db`and cg.item_group is null` : db``}
      ${group && group !== '기타' ? db`and cg.item_group = ${group}` : db``}
  `;

  const from = db`
    from public.recall_cache rc
    left join public.case_event_group cg on cg.case_id = rc.case_id
  `;

  const totalQuery = db<{ total: number }[]>`
    select count(*)::int as total ${from} ${where}
  `;

  const rowsQuery = db<RecallRow[]>`
    select
      rc.id, rc.origin, rc.title, rc.brand, rc.recall_country, rc.hazard_type,
      rc.published_on::text, rc.fetched_at::text, rc.domestic_check, rc.detail_url,
      rc.case_id,
      coalesce((select count(*)::int from public.case_tag t where t.case_id = rc.case_id), 0) as tag_count,
      (e.embedding is not null) as embedded,
      exists (select 1 from public.embed_queue q
              where q.target_table = 'case_event' and q.row_id = e.id and q.status = 'sent') as embedding_pending,
      coalesce((select count(*)::int from public.match_run r where r.case_id = rc.case_id), 0) as run_count,
      (select r.result_count from public.match_run r
        where r.case_id = rc.case_id order by r.started_at desc limit 1) as last_results,
      cg.item_group
    from public.recall_cache rc
    left join public.case_event e on e.id = rc.case_id
    left join public.case_event_group cg on cg.case_id = rc.case_id
    ${where}
    order by ${db.unsafe(orderBy)} ${db.unsafe(dir)} nulls last, rc.id desc
    limit ${per} offset ${offset}
  `;

  /*
    세 조회를 동시에 보낸다 (02_1차 보완 및 구현 설계서 §4.1)

    요약 집계·전체 건수·목록은 서로의 결과를 쓰지 않는다. 그런데 차례로 await
    하면 세 왕복이 앞뒤로 붙어 화면이 뜨는 시각이 셋의 합이 된다. 한꺼번에
    보내면 가장 느린 하나만큼만 기다린다.

    커넥션 풀이 셋을 동시에 감당한다(postgres.js 기본 10). 하나가 실패하면
    Promise.all 이 그 오류를 그대로 올리므로, 바깥의 try/catch 가 지금처럼
    연결 실패 화면을 그린다 — 동작이 달라지지 않는다.
  */
  const groupQuery = db<{ item_group: string | null; n: number }[]>`
    select cg.item_group, count(*)::int as n
    from public.recall_cache rc
    left join public.case_event_group cg on cg.case_id = rc.case_id
    group by cg.item_group
  `;

  const [[summary], [{ total }], rows, groups] = await Promise.all([
    summaryQuery, totalQuery, rowsQuery, groupQuery,
  ]);

  const groupCount = new Map<string, number>();
  for (const g of groups) groupCount.set(g.item_group ?? '기타', g.n);

  return { summary, rows, total, page, per, groupCount };
}

/** 26.09.01. 처럼 붙여 쓴다. ko-KR 기본값은 "26. 09. 01." 로 공백이 들어간다 */
export function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso)
    .toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' })
    .replace(/\s/g, '');
}
