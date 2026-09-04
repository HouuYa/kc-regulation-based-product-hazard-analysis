import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState, TermsNote, DoneBanner } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import {
  BoardToolbar, BoardPager, SortHeader, parseBoard, type BoardParams,
} from '@/components/Board';
import { FILE_STATUS_LABEL } from '@/lib/terms';
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
  `;

  const totalQuery = db<{ total: number }[]>`
    select count(*)::int as total
    from public.source_file f
    left join public.case_event e on e.source_file_id = f.id
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
        where mrun.case_id = e.id and rl.decision = 'ADOPTED'), 0) as adopted
    from public.source_file f
    left join public.case_event e on e.source_file_id = f.id
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
  const [[summary], [{ total }], rows] = await Promise.all([
    summaryQuery, totalQuery, rowsQuery,
  ]);

  return { summary, rows, total, page, per };
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
        workflow={[
          { label: 'PDF 등록', href: '#accidents-upload' },
          { label: '원문 확인' },
          { label: '분석 실행' },
          { label: '후보 검토', href: '#accidents-list' },
        ]}
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
