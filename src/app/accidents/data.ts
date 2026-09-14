import { getDb } from '@/lib/db';
import { parseBoard, type BoardParams } from '@/components/Board';

/**
 * 사고보고서 화면 — 현황/처리할 것 두 페이지가 함께 쓰는 조회·상수 (2026-09-14)
 *
 * 전에는 한 페이지 안에서 탭(Tabs)으로만 갈렸다(073). 「검토·인사이트를 별도
 * 화면으로 분리」(와이어프레임 1a)를 사고보고서·리콜 목록에도 적용하면서 URL
 * 자체를 나눴다 — `/accidents`(처리할 것, 기본)와 `/accidents/status`(현황).
 * 두 페이지가 같은 집계·목록 조회를 쓰므로 이 파일로 뽑아 둔다(CLAUDE.md §9,
 * 두 곳에 각자 복사해 두면 스키마가 바뀔 때 한쪽만 고치게 된다).
 */

export interface Summary {
  files: number;
  fileErrors: number;
  cases: number;
  confirmed: number;
  coded: number;
  embedded: number;
  analyzed: number;
  adopted: number;
}

export interface FileRow {
  id: number;
  filename: string;
  page_count: number | null;
  extracted_chars: number | null;
  status: string;
  error_reason: string | null;
  storage_path: string | null;
  preview: string | null;
  uploaded_at: string;
  case_id: number | null;
  is_confirmed: boolean | null;
  embedded: boolean | null;
  embedding_pending: boolean | null;
  tag_count: number;
  run_count: number;
  last_results: number | null;
  adopted: number;
  /** 대분류 — 059 뷰가 서류의 제품명을 품목 용어 사전으로 옮겨 얻는다. 없으면 「기타」 */
  item_group: string | null;
}

/*
  올린 뒤 무슨 일이 일어나는가 (담당자 요청, 2026-09-09)

  "파일 올리기 → 개인/민감정보 검출된 것 보이기 → 사용자가 검토 → 태깅·파싱 →
   결과를 사용자가 검수(DB에 어떻게 올라갔는지, 그다음에는 뭐 하게 되는지, 다음에
   사용자가 해야 할 일 등 알기 쉽게) → 최종 승인 처리"

  절차 자체는 이미 이 순서로 돌고 있었다. 없던 것은 「지금 어디까지 왔고 다음에
  내가 무엇을 해야 하는가」를 화면이 말해 주는 일이다. 파일 한 줄에 상태 낱말만
  흩어져 있으면 처음 쓰는 사람은 다음 동작을 못 찾는다.

  그래서 여섯 걸음을 이름 붙여 두고, 파일마다 지금 걸음과 다음 할 일을 적는다.
  사람이 해야 하는 걸음은 3(원문 확인)과 6(검수)뿐이고 나머지는 자동이다 —
  그 사실도 함께 밝힌다. 기다리면 되는 것을 기다릴 줄 알아야 한다.
*/
export const UPLOAD_STEPS = [
  { no: 1, name: '올리기', who: '사람', what: 'PDF 를 올립니다. 같은 파일은 자동으로 걸러집니다' },
  { no: 2, name: '글자 뽑기 · 개인정보 검사', who: '자동', what: 'PDF 에서 글자를 뽑고, 주민등록번호·전화번호처럼 개인정보로 보이는 값이 있는지 봅니다. 걸리면 거기서 멈추고 AI 에 보내지 않습니다' },
  { no: 3, name: '원문 확인', who: '사람', what: '뽑아낸 글자가 원본과 맞는지 봅니다. 표가 뭉개졌는지는 사람만 알 수 있습니다. 확인해야 다음으로 갑니다' },
  { no: 4, name: '코드 붙이기 · 검색 준비', who: '자동', what: '위해요인 코드를 붙이고 뜻으로 찾을 수 있게 준비합니다. 1분 안에 저절로 시작합니다' },
  { no: 5, name: '분석', who: '사람이 시작', what: '적용기준의 조항 중 이 사고와 관련된 것을 찾습니다' },
  { no: 6, name: '검수 · 채택', who: '사람', what: '찾아온 조항을 보고 시험항목으로 쓸 것을 채택합니다' },
] as const;

/** 이 파일이 지금 몇 번째 걸음에 있고, 담당자가 다음에 무엇을 해야 하는가 */
export function stepOf(r: FileRow): { step: number; next: string; blocked: boolean } {
  if (r.status === 'error') {
    return {
      step: 2,
      blocked: true,
      next: '아래 빨간 줄의 사유를 보고 판단해 주세요. 개인정보가 발견된 것이면, 그 값을 지운 파일로 다시 올려야 합니다.',
    };
  }
  if (!r.case_id) {
    return { step: 2, blocked: true, next: '사건으로 만들지 못했습니다. 개발자에게 파일명을 알려 주세요.' };
  }
  if (!r.is_confirmed) {
    return {
      step: 3,
      blocked: false,
      next: '「뽑아낸 원문 확인」을 펼쳐 표가 뭉개지지 않았는지 보고, 아래 단추를 눌러 주세요. 여기서 멈춰 있으면 다음 단계가 시작되지 않습니다.',
    };
  }
  if (!r.embedded || r.tag_count === 0) {
    return {
      step: 4,
      blocked: false,
      next: '자동으로 준비하는 중입니다. 기다리시면 됩니다 — 보통 1~2분입니다.',
    };
  }
  if (r.run_count === 0) {
    return { step: 5, blocked: false, next: '「분석 실행」을 눌러 관련 조항을 찾습니다.' };
  }
  if (r.adopted === 0) {
    return {
      step: 6,
      blocked: false,
      next: '「분석 상세보기」에서 찾아온 조항을 보고, 시험항목으로 쓸 것을 채택해 주세요.',
    };
  }
  return { step: 6, blocked: false, next: '채택까지 끝났습니다. 더 볼 것이 있으면 분석 상세보기로 갑니다.' };
}

/** 정렬 가능한 열. 주소줄에서 오는 값이므로 반드시 이 목록 안에서만 고른다 */
const SORTS: Record<string, string> = {
  uploaded_at: 'f.uploaded_at',
  filename: 'f.filename',
  status: 'f.status',
};

export async function load(params: BoardParams) {
  const db = getDb();
  const { q, per, offset, sort, dir, page } = parseBoard(params, 'uploaded_at');
  const orderBy = SORTS[sort] ?? SORTS.uploaded_at;
  const status = params.status ?? '';
  const group = params.group ?? '';

  const summaryQuery = db<Summary[]>`
    select
      (select count(*)::int from public.source_file where kind = 'ACCIDENT_PDF')                    as files,
      (select count(*)::int from public.source_file where kind = 'ACCIDENT_PDF' and status = 'error') as "fileErrors",
      (select count(*)::int from public.case_event where source_type = 'ACCIDENT')                  as cases,
      (select count(*)::int from public.case_event where source_type = 'ACCIDENT' and is_confirmed) as confirmed,
      (select count(distinct t.case_id)::int from public.case_tag t
        join public.case_event e on e.id = t.case_id where e.source_type = 'ACCIDENT')             as coded,
      (select count(*)::int from public.case_event
        where source_type = 'ACCIDENT' and embedding is not null)                                   as embedded,
      (select count(distinct r.case_id)::int from public.match_run r
        join public.case_event e on e.id = r.case_id where e.source_type = 'ACCIDENT')             as analyzed,
      (select count(*)::int from public.review_log rl
        join public.match_result mr on mr.id = rl.match_result_id
        join public.match_run mrun on mrun.id = mr.run_id
        join public.case_event e on e.id = mrun.case_id
        where e.source_type = 'ACCIDENT' and rl.decision = 'ADOPTED')                               as adopted
  `;

  const where = db`
    where f.kind = 'ACCIDENT_PDF'
      ${q ? db`and (f.filename ilike ${'%' + q + '%'} or e.title ilike ${'%' + q + '%'}
                    or e.narrative ilike ${'%' + q + '%'})` : db``}
      ${status ? db`and f.status = ${status}` : db``}
      ${group === '기타' ? db`and cg.item_group is null` : db``}
      ${group && group !== '기타' ? db`and cg.item_group = ${group}` : db``}
  `;

  const totalQuery = db<{ total: number }[]>`
    select count(*)::int as total
    from public.source_file f
    left join public.case_event e on e.source_file_id = f.id
    left join public.case_event_group cg on cg.case_id = e.id
    ${where}
  `;

  const rowsQuery = db<FileRow[]>`
    select
      f.id, f.filename, f.page_count, f.extracted_chars, f.status, f.error_reason,
      f.storage_path, f.uploaded_at::text,
      left(f.extracted_text, 420) as preview,
      e.id as case_id, e.is_confirmed,
      (e.embedding is not null) as embedded,
      exists (select 1 from public.embed_queue q
              where q.target_table = 'case_event' and q.row_id = e.id and q.status = 'sent') as embedding_pending,
      coalesce((select count(*)::int from public.case_tag t where t.case_id = e.id), 0) as tag_count,
      coalesce((select count(*)::int from public.match_run r where r.case_id = e.id), 0) as run_count,
      (select r.result_count from public.match_run r
        where r.case_id = e.id order by r.started_at desc limit 1) as last_results,
      coalesce((select count(*)::int from public.review_log rl
        join public.match_result mr on mr.id = rl.match_result_id
        join public.match_run mrun on mrun.id = mr.run_id
        where mrun.case_id = e.id and rl.decision = 'ADOPTED'), 0) as adopted,
      cg.item_group
    from public.source_file f
    left join public.case_event e on e.source_file_id = f.id
    left join public.case_event_group cg on cg.case_id = e.id
    ${where}
    order by ${db.unsafe(orderBy)} ${db.unsafe(dir)} nulls last, f.id desc
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
    from public.source_file f
    left join public.case_event e on e.source_file_id = f.id
    left join public.case_event_group cg on cg.case_id = e.id
    where f.kind = 'ACCIDENT_PDF'
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
