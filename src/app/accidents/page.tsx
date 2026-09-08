import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState, TermsNote, DoneBanner } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import {
  BoardToolbar, BoardPager, BoardTabs, SortHeader, parseBoard, type BoardParams,
} from '@/components/Board';
import { FILE_STATUS_LABEL } from '@/lib/terms';
import { GROUP_ORDER } from '@/lib/standards/label';
import { uploadAccidentPdfs, confirmCase } from './actions';
import { ActionForm } from '@/components/ActionForm';
import { AutoRefresh } from '@/components/AutoRefresh';
import { PageToc, type TocItem } from '@/components/PageToc';
import { runAnalysisAction } from '@/app/analysis/[caseId]/actions';

export const dynamic = 'force-dynamic';

const ACCIDENTS_TOC: TocItem[] = [
  { id: 'accidents-status', label: '처리 현황' },
  { id: 'accidents-upload', label: '사고보고서 올리기' },
  { id: 'accidents-list', label: '사고보고서 목록' },
];

/**
 * 사고보고서 — 등록부터 분석까지 한 화면
 *
 * 게시판 형태인 이유 (담당자 요청)
 *   건수가 늘면 전부 한 화면에 쏟을 수 없다. 찾기·정렬·쪽 넘김을 붙였다.
 *   상태는 전부 주소줄에 있어서 주소를 복사해 동료에게 보낼 수 있다.
 *
 * 위에 현황을 두는 이유
 *   목록만 있으면 "지금 몇 건이 어디까지 됐는가"를 스크롤해서 세어 봐야 한다.
 *   숫자 하나하나가 다음에 할 일을 가리킨다 — 원문 확인이 밀렸는지, 코드 부여가
 *   안 됐는지, 분석을 아직 안 돌렸는지. 현황은 찾기 조건과 무관하게 전체를 센다.
 */

interface Summary {
  files: number;
  fileErrors: number;
  cases: number;
  confirmed: number;
  coded: number;
  embedded: number;
  analyzed: number;
  adopted: number;
}

interface FileRow {
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
const UPLOAD_STEPS = [
  { no: 1, name: '올리기', who: '사람', what: 'PDF 를 올립니다. 같은 파일은 자동으로 걸러집니다' },
  { no: 2, name: '글자 뽑기 · 개인정보 검사', who: '자동', what: 'PDF 에서 글자를 뽑고, 주민등록번호·전화번호처럼 개인정보로 보이는 값이 있는지 봅니다. 걸리면 거기서 멈추고 AI 에 보내지 않습니다' },
  { no: 3, name: '원문 확인', who: '사람', what: '뽑아낸 글자가 원본과 맞는지 봅니다. 표가 뭉개졌는지는 사람만 알 수 있습니다. 확인해야 다음으로 갑니다' },
  { no: 4, name: '코드 붙이기 · 검색 준비', who: '자동', what: '위해요인 코드를 붙이고 뜻으로 찾을 수 있게 준비합니다. 1분 안에 저절로 시작합니다' },
  { no: 5, name: '분석', who: '사람이 시작', what: '적용기준의 조항 중 이 사고와 관련된 것을 찾습니다' },
  { no: 6, name: '검수 · 채택', who: '사람', what: '찾아온 조항을 보고 시험항목으로 쓸 것을 채택합니다' },
] as const;

/** 이 파일이 지금 몇 번째 걸음에 있고, 담당자가 다음에 무엇을 해야 하는가 */
function stepOf(r: FileRow): { step: number; next: string; blocked: boolean } {
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

async function load(params: BoardParams) {
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
function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso)
    .toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' })
    .replace(/\s/g, '');
}

export default async function AccidentsPage({
  searchParams,
}: {
  searchParams: Promise<BoardParams & { done?: string }>;
}) {
  const params = await searchParams;
  const { done } = params;

  let data: Awaited<ReturnType<typeof load>> | null = null;
  let error: string | null = null;
  try {
    data = await load(params);
  } catch (e) {
    console.error('사고보고서 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_10rem]">
      <div>
      <PageHead
        label="2 · 사고보고서"
        title="사고보고서와 안전기준 연계 분석"
        lead="PDF를 올리고 원문을 확인하면, 사고와 관련될 수 있는 안전기준 조항을 찾습니다."
        /* 여섯 걸음의 이름과 뜻은 UPLOAD_STEPS 에 한 벌만 둔다 */
        workflow={data ? [
          { label: '올리기', who: '사람', href: '#accidents-upload', note: `${data.summary.files}건`, state: 'done' },
          {
            label: '글자·개인정보 검사',
            note: data.summary.fileErrors > 0 ? `막힘 ${data.summary.fileErrors}` : '이상 없음',
            state: data.summary.fileErrors > 0 ? 'here' : 'done',
          },
          {
            label: '원문 확인',
            who: '사람',
            note: `${data.summary.confirmed} / ${data.summary.cases}`,
            state: data.summary.confirmed < data.summary.cases ? 'here' : 'done',
          },
          {
            label: '코드·검색 준비',
            note: `${data.summary.embedded} / ${data.summary.cases}`,
            state: data.summary.embedded < data.summary.cases ? 'here' : 'done',
          },
          {
            label: '분석',
            who: '사람',
            note: `${data.summary.analyzed} / ${data.summary.confirmed}`,
            state: data.summary.analyzed < data.summary.confirmed ? 'here' : 'done',
          },
          {
            label: '검수·채택',
            who: '사람',
            href: '#accidents-list',
            note: `채택 ${data.summary.adopted}`,
            state: 'todo',
          },
        ] : undefined}
      />

      <DoneBanner message={done} />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          <div id="accidents-status" className="scroll-mt-8">
          <StatusBar
            items={[
              { label: '올린 문서', value: data.summary.files, note: '사고조사보고서 PDF' },
              {
                label: '추출 오류', value: data.summary.fileErrors, wantsZero: true,
                note: '글자가 없는 스캔본이거나 개인정보가 들어 있는 문서입니다. 분석까지 가지 않습니다',
              },
              {
                label: '원문 확인함', value: data.summary.confirmed, of: data.summary.cases,
                note: '뽑아낸 글자를 담당자가 직접 확인한 문서입니다. 확인해야 분석할 수 있습니다',
              },
              {
                label: '위해요인 코드', value: data.summary.coded, of: data.summary.cases,
                note: '원인(HF)과 피해유형(DT) 코드가 붙은 사고',
              },
              {
                label: '의미 검색 준비', value: data.summary.embedded, of: data.summary.cases,
                note: '단어가 달라도 뜻이 비슷한 조항까지 찾아냅니다. 새로 들어온 자료는 저절로 준비됩니다',
              },
              {
                label: '분석 실행됨', value: data.summary.analyzed, of: data.summary.cases,
                note: '관련될 수 있는 조항을 찾아 순위까지 매긴 사고',
              },
              {
                label: '채택된 조항', value: data.summary.adopted,
                note: '담당자가 "관련 있다"고 확인한 조항입니다. 이 기록으로 정확도를 잽니다',
              },
            ]}
          />
          </div>

          <details id="accidents-upload" className="mt-10 scroll-mt-8 border border-rule bg-surface px-5 py-4">
            <summary className="cursor-pointer text-[13px] font-medium">
              사고보고서 올리기
            </summary>
            <form action={uploadAccidentPdfs} className="mt-3">
              <p className="text-[12px] leading-relaxed text-ink-3">
                여러 건을 한 번에 올릴 수 있습니다. 한 건이 실패해도 나머지는 계속 처리합니다.
                같은 파일을 다시 올리면 건너뜁니다. 주민등록번호·연락처처럼 개인정보로 보이는
                값이 발견되면 그 파일은 AI 처리로 넘기지 않습니다.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input
                  id="files" name="files" type="file" accept="application/pdf" multiple required
                  className="text-[12px] file:mr-3 file:border file:border-rule file:bg-paper file:px-3 file:py-1.5 file:text-[12px] file:text-ink"
                />
                <button
                  type="submit"
                  className="border border-measure bg-measure px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
                >
                  올리기
                </button>
              </div>
            </form>
          </details>

          {/* 올린 뒤 무슨 일이 일어나는가 (담당자 요청, 2026-09-09) */}
          <details className="mt-4 border border-rule-soft">
            <summary className="cursor-pointer px-4 py-2.5 text-[12px] text-ink-2">
              올린 뒤 무슨 일이 일어나는지 — 여섯 걸음 중{' '}
              <span className="text-ink">사람이 할 일은 두 걸음</span>입니다
            </summary>
            <div className="border-t border-rule-soft px-4 py-3.5">
              {UPLOAD_STEPS.map((st) => (
                <div key={st.no} className="flex gap-3 border-t border-rule-soft py-2 first:border-t-0">
                  <span className="addr tnum w-4 shrink-0 text-[12px] text-ink-3">{st.no}</span>
                  <div className="min-w-0">
                    <div className="text-[12px]">
                      <span className="font-medium">{st.name}</span>
                      <span
                        className={`ml-2 border px-1 text-[10px] ${
                          st.who === '자동' ? 'border-rule text-ink-3' : 'border-measure text-measure'
                        }`}
                      >
                        {st.who}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">{st.what}</p>
                  </div>
                </div>
              ))}
              <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
                걸음 3 에서 멈춰 있는 파일은 다음으로 가지 않습니다. 뽑아낸 글자가 원본과
                다른데 그대로 분석하면, 없는 사고를 분석하는 셈이 되기 때문입니다.
              </p>
            </div>
          </details>

          {/* 준비가 밀려 있으면 숫자가 계속 바뀐다 — 새로고침을 사람이 누르지 않게 한다 */}
          <div className="mt-4">
            <AutoRefresh
              active={data.summary.embedded < data.summary.cases}
              seconds={20}
              label="의미 검색 준비가 진행 중입니다 — 숫자가 저절로 갱신됩니다"
            />
          </div>

          <BoardToolbar
            basePath="/accidents"
            params={params}
            placeholder="파일명·제목·본문으로 찾기"
            filters={[{
              name: 'status',
              label: '진행',
              options: Object.entries(FILE_STATUS_LABEL).map(([value, label]) => ({ value, label })),
            }]}
          />

          {/* 대분류 — 담당자는 대개 한 대분류만 맡는다(2026-09-09) */}
          <BoardTabs
            basePath="/accidents"
            params={params}
            name="group"
            options={GROUP_ORDER.map((g) => ({
              value: g,
              label: `${g} ${(data.groupCount.get(g) ?? 0).toLocaleString()}`,
            }))}
          />

          {data.total === 0 ? (
            <EmptyState
              message={
                params.q || params.status
                  ? '조건에 맞는 사고보고서가 없습니다. 찾기 조건을 지워 보세요.'
                  : '아직 올린 사고보고서가 없습니다. 위 「사고보고서 올리기」를 펼쳐 시작하세요.'
              }
            />
          ) : (
            <section id="accidents-list" className="mt-6 scroll-mt-8">
              <div className="label grid grid-cols-[1fr_auto_auto] gap-3 border-b border-rule pb-2">
                <SortHeader basePath="/accidents" params={params} field="filename" label="사고보고서" />
                <SortHeader basePath="/accidents" params={params} field="status" label="진행" />
                <SortHeader basePath="/accidents" params={params} field="uploaded_at" label="올린 날짜" align="right" />
              </div>

              {data.rows.map((r) => (
                <article key={r.id} className="border-b border-rule py-3.5">
                  <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3">
                    <span className="text-[13px] font-medium">{r.filename}</span>
                    <span className={`text-[11px] ${r.status === 'error' ? 'text-halt' : 'text-ink-3'}`}>
                      {FILE_STATUS_LABEL[r.status] ?? r.status}
                    </span>
                    <span className="addr tnum text-right text-[11px] text-ink-3">
                      {when(r.uploaded_at)}
                    </span>
                  </div>

                  <div className="addr tnum mt-1 text-[11px] text-ink-3">
                    <span className={r.item_group ? 'text-ink-2' : 'text-ink-3'}>
                      {r.item_group ?? '기타'}
                    </span>
                    {' · '}
                    {r.page_count ?? '—'}쪽 · 뽑아낸 글자 {(r.extracted_chars ?? 0).toLocaleString()}자
                    {/*
                      원본 미보관은 이제 중립적인 상태가 아니다 (02 설계서 §3.3)

                      사고보고서는 개인정보 때문에 저장소에 두지 않으므로 Storage 가
                      유일한 원본 보관처다. 원본이 없으면 조항 결과에서 원문 페이지로
                      되짚을 수 없다 — 이 체계가 지키기로 한 것이 그 되짚기다.
                      지금은 보관에 실패하면 사건을 만들지 않지만, 그 전에 들어온
                      자료 중에는 원본 없이 분석까지 간 것이 남아 있을 수 있다.
                    */}
                    {r.storage_path ? (
                      ' · 원본 보관됨'
                    ) : (
                      <span className="text-caution"> · 원본 미보관 — 원문 역추적 불가</span>
                    )}
                    {r.tag_count > 0 && ` · 위해요인 코드 ${r.tag_count}`}
                    {r.embedded
                      ? ' · 의미 검색 준비됨'
                      : r.embedding_pending
                        ? ' · 의미 검색 준비 중…'
                        : ''}
                  </div>

                  {/*
                    파일마다 「지금 몇 번째 걸음이고 다음에 무엇을 해야 하는가」
                    (담당자 요청, 2026-09-09). 상태 낱말만 흩어져 있으면 처음 쓰는
                    사람은 다음 동작을 못 찾는다.
                  */}
                  {(() => {
                    const st = stepOf(r);
                    return (
                      <div
                        className={`mt-2 border-l-2 px-3 py-1.5 text-[12px] leading-relaxed ${
                          st.blocked ? 'border-halt bg-halt-soft text-ink-2' : 'border-rule bg-surface text-ink-2'
                        }`}
                      >
                        <span className="addr text-[11px] text-ink-3">
                          {st.step}/6 {UPLOAD_STEPS[st.step - 1].name}
                        </span>
                        <span className="ml-2">{st.next}</span>
                      </div>
                    );
                  })()}

                  {r.error_reason && (
                    <p className="mt-2 border-l-2 border-halt bg-halt-soft px-3 py-2 text-[12px] leading-relaxed text-ink-2">
                      {r.error_reason}
                    </p>
                  )}

                  {r.preview && (
                    <details className="mt-2.5">
                      <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink">
                        뽑아낸 원문 확인
                      </summary>
                      <pre className="mt-1.5 max-h-56 overflow-auto border border-rule bg-surface px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
                        {r.preview}
                      </pre>
                    </details>
                  )}

                  {r.case_id && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-3">
                      {r.is_confirmed ? (
                        <>
                          <span className="text-[12px] text-measure">원문 확인함</span>
                          <Link
                            href={`/analysis/${r.case_id}`}
                            className="text-[12px] text-measure underline underline-offset-2"
                          >
                            분석 상세보기
                          </Link>
                          <ActionForm
                            action={runAnalysisAction}
                            hidden={{ caseId: r.case_id }}
                            label={r.run_count > 0 ? '분석 다시 실행' : '분석 실행'}
                            pendingLabel="분석하는 중…"
                            className="border border-rule px-3 py-1.5 text-[12px] hover:bg-measure-soft"
                          />
                          <span className="addr tnum text-[11px] text-ink-3">
                            {r.run_count > 0
                              ? `관련 조항 후보 ${r.last_results ?? 0}건${r.adopted > 0 ? ` · 채택 ${r.adopted}` : ''}`
                              : '아직 분석하지 않음'}
                          </span>
                        </>
                      ) : (
                        <>
                          <ActionForm
                            action={confirmCase}
                            hidden={{ caseId: r.case_id }}
                            label="원문을 확인했습니다 — 분석 대상으로"
                            pendingLabel="처리하는 중…"
                            className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft"
                          />
                          <span className="text-[11px] text-ink-3">
                            위 「뽑아낸 원문 확인」을 펼쳐 표가 뭉개지지 않았는지 보고 눌러 주세요
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </article>
              ))}

              <BoardPager
                basePath="/accidents" params={params}
                total={data.total} page={data.page} per={data.per}
              />
            </section>
          )}
        </>
      )}

      <TermsNote />
      </div>
      <PageToc items={ACCIDENTS_TOC} />
      </div>
    </div>
  );
}
