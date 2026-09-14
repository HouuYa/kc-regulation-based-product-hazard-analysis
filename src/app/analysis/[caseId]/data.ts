import { cache } from 'react';
import { getDb } from '@/lib/db';
import { getSignedUrl } from '@/lib/supabase/server';
import { standardsForCase } from '@/lib/cases/resolve-scope';
import type { GpcCandidate } from '@/lib/gpc/lookup';
import type { GpcMatchLevel } from '@/lib/gpc/verify';
import type { MatchPath } from '@/components/EvidenceStrip';

/**
 * 사건 분석 화면 — 검토(`page.tsx`)/인사이트(`insight/page.tsx`) 두 페이지와
 * 공통 헤더(`layout.tsx`)가 함께 쓰는 조회 (2026-09-14, 와이어프레임 1a)
 *
 * 전에는 한 페이지 안에서 탭(Tabs)으로만 갈렸다(073). 이제 URL 자체가
 * 갈리므로, 셋 다 같은 사건 조회(`load`)가 필요하다 — 사건 요약·품목·적용기준은
 * 레이아웃이, 관련 조항·병행점검 큐는 검토 페이지가, GPC·해외리콜·병행점검
 * 소견은 인사이트 페이지가 이 결과에서 자기 몫만 꺼내 쓴다.
 *
 * `cache()` 로 감싸는 이유
 *   레이아웃과 그 아래 페이지는 각자 독립된 서버 컴포넌트라 데이터를 자동으로
 *   나눠 갖지 않는다. 셋 다 이 함수를 부르면 그대로 두면 같은 요청 안에서
 *   DB 를 세 번 왕복한다. React 의 `cache()` 는 같은 렌더(요청) 안에서 같은
 *   인자로 부른 호출을 하나로 묶어 준다 — Next.js 가 이 문제에 공식으로 권하는
 *   방법이다.
 */

export interface CaseEventRow {
  id: number; title: string | null; narrative: string; item_name: string | null;
  source_type: string; occurred_on: string | null; source_file_id: number | null;
  product_scope_id: number | null; scope_evidence: string | null; basis_date: string | null;
  scope_name: string | null;
  child_product_check: string; child_product_note: string | null;
  gpc_brick_code: string | null; gpc_candidates: GpcCandidate[] | null;
  /** 이 코드가 어디서 왔나 (065) — EXPERT · OECD · SOURCE_AI · OUR_AI */
  gpc_source: string | null;
  gpc_verified_level: GpcMatchLevel | null;
  gpc_verified_segment_code: string | null; gpc_verified_segment_title: string | null;
  gpc_verified_family_code: string | null; gpc_verified_family_title: string | null;
  gpc_verified_class_code: string | null; gpc_verified_class_title: string | null;
  gpc_verified_brick_code: string | null; gpc_verified_brick_title: string | null;
  gpc_verification: { confidenceScore: number; reasoning: string } | null;
}

export interface ResultRow {
  id: number;
  clause_id: number;
  search_score: string;
  match_path: MatchPath;
  rank_code: number | null;
  rank_keyword: number | null;
  rank_vector: number | null;
  rerank_score: string | null;
  rerank_reason: string | null;
  final_rank: number;
  marker: string;
  breadcrumb_path: string | null;
  body: string;
  standard_name: string | null;
  /** 그 기준이 무슨 품목의 기준인가 — 번호만 보고는 알 수 없다 */
  standard_item: string | null;
  has_reviewed_tag: boolean;
  codes: string[] | null;
  test_conditions: string[] | null;
  test_methods: Array<{ marker: string; body: string | null }> | null;
  decision: string | null;
  reject_reason: string | null;
  /** 이 조항이 속한 절의 제목. 절 껍데기 조항에서 끌어온다 */
  section_title: string | null;
}

export interface StandardRow {
  display_name: string; item_name: string | null; title_ko: string | null;
  items: string[] | null; sub_items: string[] | null; relation: string | null;
}

export interface RecallRow {
  source: string; guid: string; recall_country: string | null;
  hazard_type: string | null; detail_url: string | null;
  cited_standards: string[]; matched_standard_ids: number[]; domestic_check: string;
}

export interface PhotoRow {
  id: number; page_number: number; storage_path: string;
  is_relevant_photo: boolean | null; description: string | null;
  hazard_note: string | null; analyzed_at: string | null;
  url: string | null;
}

export interface RunRow {
  id: number; started_at: string; use_code: boolean; use_keyword: boolean;
  use_vector: boolean; use_rerank: boolean; result_count: number;
  rerank_model: string | null; embedding_model: string | null;
  rerank_status: 'skipped' | 'ok' | 'failed';
  hyde_text: string | null;
}

export interface TagRow { axis: string; code: string; is_primary: boolean }

export const load = cache(async (caseId: number) => {
  const db = getDb();

  const [ev] = await db<CaseEventRow[]>`
    select e.id, e.title, e.narrative, e.item_name, e.source_type, e.occurred_on::text,
           e.source_file_id,
           e.product_scope_id, e.scope_evidence, e.basis_date::text,
           e.child_product_check, e.child_product_note,
           ps.name as scope_name,
           e.gpc_brick_code, e.gpc_candidates, e.gpc_source,
           e.gpc_verified_level,
           e.gpc_verified_segment_code, e.gpc_verified_segment_title,
           e.gpc_verified_family_code, e.gpc_verified_family_title,
           e.gpc_verified_class_code, e.gpc_verified_class_title,
           e.gpc_verified_brick_code, e.gpc_verified_brick_title,
           e.gpc_verification
    from public.case_event e
    left join public.product_scope ps on ps.id = e.product_scope_id
    where e.id = ${caseId}
  `;
  if (!ev) return null;

  /*
    사고사진 (068) — 원본 PDF 는 개인정보 때문에 저장소에 없으므로, 미리 뽑아
    Storage 에 저장해 둔 사진만 보여 준다(process-photos.ts). 버킷이 비공개라
    서명 URL을 서버에서 만들어 넘긴다 — service_role 키는 화면 밖으로 안 나간다.
  */
  const photos: PhotoRow[] = ev.source_file_id
    ? await (async () => {
        const rows = await db<Omit<PhotoRow, 'url'>[]>`
          select id, page_number, storage_path, is_relevant_photo, description,
                 hazard_note, analyzed_at::text
          from public.source_file_image
          where source_file_id = ${ev.source_file_id}
          order by page_number
        `;
        return Promise.all(
          rows.map(async (r) => ({
            ...r,
            url: await getSignedUrl(r.storage_path).catch(() => null),
          })),
        );
      })()
    : [];

  // 이 사건에 적용되는 기준. 품목 확정의 결과이자 검색 범위 그 자체다(v0.7 §3.2).
  // 명령줄 분석과 같은 함수를 쓴다 — 화면과 실제 검색 범위가 어긋나면 안 된다.
  const standardIds = await standardsForCase(caseId);
  /*
    번호만으로는 담당자가 알 수 없다 (담당자 지적, 2026-09-09)

    "모든 것들은 안전기준에 있는 품목 명칭을 다 꼭 모두 넣어 주세요(다른 페이지 포함).
     왜냐하면 검토 시 너무 양이 많아 분간이 어렵다." 안전기준 담당자는 품목별로
    나뉘어 있어 자기 품목군 밖의 번호는 읽어도 무엇인지 모른다. 그래서 이 화면도
    번호 옆에 품목명을 함께 싣는다. 이름의 재료는 standard_view 에 모여 있다(057·058).
  */
  const standards = standardIds.length
    ? await db<StandardRow[]>`
        select s.display_name, s.item_name, s.title_ko, s.items, s.sub_items,
               (select a.relation from public.standard_applicability a
                where a.standard_id = s.id and a.product_scope_id = ${ev.product_scope_id}
                limit 1) as relation
        from public.standard_view s
        where s.id = any(${standardIds}::bigint[])
        order by s.display_name
      `
    : [];

  // 해외 리콜이면 트랙 B 의 재료를 함께 싣는다
  const [recall] = ev.source_type === 'RECALL_OVERSEAS'
    ? await db<RecallRow[]>`
        select source, guid, recall_country, hazard_type, detail_url,
               cited_standards, matched_standard_ids, domestic_check
        from public.recall_cache where case_id = ${caseId} limit 1
      `
    : [];

  const tags = await db<TagRow[]>`
    select axis, code, is_primary from public.case_tag
    where case_id = ${caseId} and review_status <> 'rejected'
    order by is_primary desc, axis, code
  `;

  const [run] = await db<RunRow[]>`
    select id, started_at::text, use_code, use_keyword, use_vector, use_rerank,
           result_count, rerank_model, embedding_model, rerank_status, hyde_text
    from public.match_run where case_id = ${caseId}
    order by started_at desc limit 1
  `;

  const results = run
    ? await db<ResultRow[]>`
        select
          r.id, r.clause_id, r.search_score, r.match_path,
          r.rank_code, r.rank_keyword, r.rank_vector,
          r.rerank_score, r.rerank_reason, r.final_rank,
          c.marker, c.breadcrumb_path, c.body,
          s.display_name as standard_name,
          -- 조항이 어느 품목의 기준인지도 함께 — 번호만으로는 분간이 안 된다(2026-09-09)
          coalesce(s.item_name, s.title_ko) as standard_item,
          exists (select 1 from public.clause_tag t
                  where t.clause_id = c.id and t.review_status = 'approved') as has_reviewed_tag,
          (select array_agg(t.code order by t.is_primary desc, t.axis)
           from public.clause_tag t where t.clause_id = c.id) as codes,
          (select array_agg(tc.item_name || ' ' || coalesce(tc.allowance_raw,'') order by tc.id)
           from public.test_condition tc where tc.clause_id = c.id) as test_conditions,
          (select json_agg(json_build_object('marker', l.to_marker, 'body', tm.body))
           from public.clause_link l
           left join public.clause tm on tm.id = l.to_clause_id
           where l.from_clause_id = c.id and l.link_type = 'TEST_METHOD') as test_methods,
          (select rl.decision from public.review_log rl
           where rl.match_result_id = r.id order by rl.created_at desc limit 1) as decision,
          (select rl.reject_reason from public.review_log rl
           where rl.match_result_id = r.id order by rl.created_at desc limit 1) as reject_reason,
          /*
            이 조항이 속한 절의 제목 (2026-09-05)

            담당자는 "절 15 를 보라"고 말하는데 화면은 "15.1"만 보여 줬다. 절 번호만으로는
            무슨 시험인지 알 수 없어 조항을 하나씩 열어 봐야 했다. 절 껍데기 조항이
            제목을 갖고 있으므로(IEC 계열에서 절은 제목만 있는 껍데기다) 그것을 끌어온다.

            같은 부(part)의 절을 골라야 한다 — 실측으로 걸러 낸 함정이다.
            KC 60335-1 에는 marker='11' 인 조항이 본문·부속서 B·E·H·P·S 로 여섯 개 있고,
            본문에서는 "온도 상승"이지만 부속서 E 에서는 "시험 결과의 평가"다. 부를 맞추지
            않고 본문 길이로 골랐더니 온도 상승 조항에 엉뚱한 제목이 붙었다.
          */
          (select coalesce(nullif(trim(sec.title_raw), ''), nullif(trim(sec.body), ''))
             from public.clause sec
            where sec.standard_id = c.standard_id
              and sec.marker = split_part(c.marker, '.', 1)
              and sec.part is not distinct from c.part
            -- 제목이 있는 것을 먼저, 그다음 본문이 짧은 것(껍데기가 곧 제목이다)
            order by (sec.title_raw is null), length(coalesce(sec.body, ''))
            limit 1) as section_title
        from public.match_result r
        join public.clause c   on c.id = r.clause_id
        join public.standard s on s.id = c.standard_id
        where r.run_id = ${run.id}
        order by r.final_rank
      `
    : [];

  return { ev, tags, run, results, standards, recall, photos };
});

export type CaseData = NonNullable<Awaited<ReturnType<typeof load>>>;
