import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState, TermsNote, DoneBanner } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { FILE_STATUS_LABEL } from '@/lib/terms';
import { uploadAccidentPdfs, confirmCase } from './actions';
import { runAnalysisAction } from '@/app/analysis/[caseId]/actions';

export const dynamic = 'force-dynamic';

/**
 * 사고보고서 — 등록부터 분석까지 한 화면 (담당자 요청)
 *
 * 전에는 등록이 /cases, 분석 목록이 /analysis 로 나뉘어 있었고 리콜과 한 통에
 * 섞여 있었다. 담당자가 실제로 하는 일은 "사고보고서를 올려서 KC안전기준과
 * 연계 분석한다" 하나인데 화면이 셋으로 흩어져 있던 셈이다.
 *
 * 위에 현황을 두는 이유
 *   목록만 있으면 "지금 몇 건이 어디까지 됐는가"를 스크롤해서 세어 봐야 한다.
 *   그리고 숫자 하나하나가 다음에 할 일을 가리킨다 — 원문 확인이 밀렸는지,
 *   코드 부여가 안 됐는지, 분석을 아직 안 돌렸는지.
 *
 * 명령어 안내를 지웠다
 *   전에는 각 줄에 `npm run search -- --case 4639` 가 붙어 있었다. 화면에서
 *   분석을 돌릴 방법이 없었기 때문인데, 이제 「분석 실행」 버튼이 그 일을 한다.
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
  case_id: number | null;
  is_confirmed: boolean | null;
  embedded: boolean | null;
  tag_count: number;
  run_count: number;
  last_results: number | null;
  adopted: number;
}

async function load(): Promise<{ summary: Summary | null; rows: FileRow[]; error: string | null }> {
  try {
    const db = getDb();

    const [summary] = await db<Summary[]>`
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

    const rows = await db<FileRow[]>`
      select
        f.id, f.filename, f.page_count, f.extracted_chars, f.status, f.error_reason,
        f.storage_path,
        left(f.extracted_text, 420) as preview,
        e.id as case_id, e.is_confirmed,
        (e.embedding is not null) as embedded,
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
      where f.kind = 'ACCIDENT_PDF'
      order by f.uploaded_at desc
    `;

    return { summary, rows, error: null };
  } catch (e) {
    console.error('사고보고서 화면 조회 실패:', e);
    return { summary: null, rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function AccidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const { done } = await searchParams;
  const { summary, rows, error } = await load();

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="2 · 사고보고서"
        title="사고보고서와 안전기준 연계 분석"
        lead="개인정보를 지운 PDF 를 올리면 글자를 뽑아 냅니다. 담당자가 원문을 확인하면 분석 대상이 되고, 사고에 붙은 위해요인 코드로 관련될 수 있는 안전기준 조항을 찾습니다."
      />

      <DoneBanner message={done} />

      {error && <ConnectionError error={error} />}

      {summary && (
        <StatusBar
          items={[
            { label: '올린 문서', value: summary.files, note: '사고조사보고서 PDF' },
            {
              label: '추출 오류', value: summary.fileErrors, wantsZero: true,
              note: '스캔본이거나 개인정보가 발견된 문서. 분석으로 넘어가지 않습니다',
            },
            {
              label: '원문 확인함', value: summary.confirmed, of: summary.cases,
              note: '담당자가 추출 결과를 눈으로 확인한 건. 확인해야 분석 대상이 됩니다',
            },
            {
              label: '위해요인 코드', value: summary.coded, of: summary.cases,
              note: '원인(HF)·피해유형(DT) 코드가 붙은 건',
            },
            {
              label: '의미 검색 준비', value: summary.embedded, of: summary.cases,
              note: '단어가 달라도 뜻이 비슷한 조항을 찾을 수 있는 상태. 자동으로 준비됩니다',
            },
            {
              label: '분석 실행됨', value: summary.analyzed, of: summary.cases,
              note: '관련 조항을 찾아 순위를 매긴 건',
            },
            {
              label: '채택된 조항', value: summary.adopted,
              note: '담당자가 "관련 있다"고 확인한 조항. 정확도 측정의 재료입니다',
            },
          ]}
        />
      )}

      {!error && (
        <form action={uploadAccidentPdfs} className="mt-10 border border-rule bg-surface px-5 py-5">
          <label htmlFor="files" className="block text-[13px] font-medium">
            PDF 선택 — 여러 건을 한 번에 올릴 수 있습니다
          </label>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
            한 건이 실패해도 나머지는 계속 처리합니다. 같은 파일을 다시 올리면 건너뜁니다.
            주민등록번호·연락처처럼 개인정보로 보이는 값이 발견되면 그 파일은 AI 처리로
            넘기지 않습니다.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
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
      )}

      {!error && rows.length === 0 && (
        <EmptyState message="아직 올린 사고보고서가 없습니다. 위에서 PDF 를 선택해 시작하세요." />
      )}

      {rows.length > 0 && (
        <section className="mt-10">
          <h2 className="text-[15px] font-semibold">등록된 사고보고서 {rows.length}건</h2>

          {rows.map((r) => (
            <article key={r.id} className="border-t border-rule py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-[13px] font-medium">{r.filename}</span>
                <span className={`text-[11px] ${r.status === 'error' ? 'text-halt' : 'text-ink-3'}`}>
                  {FILE_STATUS_LABEL[r.status] ?? r.status}
                </span>
              </div>

              <div className="addr tnum mt-1 text-[11px] text-ink-3">
                {r.page_count ?? '—'}쪽 · 뽑아낸 글자 {(r.extracted_chars ?? 0).toLocaleString()}자
                {r.storage_path ? ' · 원본 보관됨' : ' · 원본 미보관'}
                {r.tag_count > 0 && ` · 위해요인 코드 ${r.tag_count}`}
                {r.embedded && ' · 의미 검색 준비됨'}
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
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {r.is_confirmed ? (
                    <>
                      <span className="text-[12px] text-measure">원문 확인함</span>
                      <Link
                        href={`/analysis/${r.case_id}`}
                        className="text-[12px] text-measure underline underline-offset-2"
                      >
                        이 사건 분석 보기
                      </Link>
                      <form action={runAnalysisAction}>
                        <input type="hidden" name="caseId" value={r.case_id} />
                        <input type="hidden" name="returnTo" value="/accidents" />
                        <button
                          type="submit"
                          className="border border-rule px-3 py-1.5 text-[12px] hover:bg-measure-soft"
                        >
                          {r.run_count > 0 ? '분석 다시 실행' : '분석 실행'}
                        </button>
                      </form>
                      <span className="addr tnum text-[11px] text-ink-3">
                        {r.run_count > 0
                          ? `관련 조항 후보 ${r.last_results ?? 0}건${r.adopted > 0 ? ` · 채택 ${r.adopted}` : ''}`
                          : '아직 분석하지 않음'}
                      </span>
                    </>
                  ) : (
                    <>
                      <form action={confirmCase}>
                        <input type="hidden" name="caseId" value={r.case_id} />
                        <button
                          type="submit"
                          className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft"
                        >
                          원문을 확인했습니다 — 분석 대상으로
                        </button>
                      </form>
                      <span className="text-[11px] text-ink-3">
                        위 「뽑아낸 원문 확인」을 펼쳐 표가 뭉개지지 않았는지 보고 눌러 주세요
                      </span>
                    </>
                  )}
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      <TermsNote />
    </div>
  );
}
