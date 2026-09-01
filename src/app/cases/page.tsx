import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState } from '@/components/Panel';
import { uploadAccidentPdfs, confirmCase } from './actions';

export const dynamic = 'force-dynamic';

/**
 * 화면 A — 사고보고서 업로드·등록 결과 (설계문서 §8.1)
 *
 * 등록 결과 화면에 반드시 보여야 하는 것
 *   - 파일명·페이지 수·추출 글자 수 (0 에 가까우면 스캔본 신호)
 *   - 추출된 원문 미리보기 — L0 가 표를 뭉갰는지 담당자가 눈으로 확인
 *   - 건별 확정 버튼. 확정 전에는 분석 대상에 들어가지 않는다
 */

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
  tag_count: number;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '대기',
  extracting: '추출 중',
  extracted: '추출 완료',
  coded: '코드화 완료',
  confirmed: '확정',
  error: '오류',
};

export default async function CasesPage() {
  let rows: FileRow[] = [];
  let error: string | null = null;

  try {
    rows = await getDb()<FileRow[]>`
      select
        f.id, f.filename, f.page_count, f.extracted_chars, f.status, f.error_reason,
        f.storage_path,
        left(f.extracted_text, 420) as preview,
        e.id as case_id, e.is_confirmed,
        coalesce((select count(*)::int from public.case_tag t where t.case_id = e.id), 0) as tag_count
      from public.source_file f
      left join public.case_event e on e.source_file_id = f.id
      where f.kind = 'ACCIDENT_PDF'
      order by f.uploaded_at desc
    `;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="3 · 사건"
        title="사고보고서 등록"
        lead="개인정보를 제외한 PDF 를 올립니다. 추출한 원문을 담당자가 확인하고 확정해야 분석 대상이 됩니다."
      />

      {error && <ConnectionError error={error} />}

      {!error && (
        <form action={uploadAccidentPdfs} className="mt-8 border border-rule bg-surface px-5 py-5">
          <label htmlFor="files" className="block text-[13px] font-medium">
            PDF 선택 — 여러 건을 한 번에 올릴 수 있습니다
          </label>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
            한 건이 실패해도 나머지는 계속 처리합니다. 같은 파일을 다시 올리면 건너뜁니다.
            주민등록번호·연락처처럼 개인정보로 보이는 값이 발견되면 그 파일은 코드화로
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
          <h2 className="text-[15px] font-semibold">등록 결과 {rows.length}건</h2>

          {rows.map((r) => (
            <article key={r.id} className="border-t border-rule py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-[13px] font-medium">{r.filename}</span>
                <span
                  className={`text-[11px] ${r.status === 'error' ? 'text-halt' : 'text-ink-3'}`}
                >
                  {STATUS_LABEL[r.status] ?? r.status}
                </span>
              </div>

              <div className="addr tnum mt-1 text-[11px] text-ink-3">
                {r.page_count ?? '—'}쪽 · 추출 {(r.extracted_chars ?? 0).toLocaleString()}자
                {r.storage_path ? ' · 원본 보관됨' : ' · 원본 미보관'}
                {r.tag_count > 0 && ` · 코드 ${r.tag_count}`}
              </div>

              {r.error_reason && (
                <p className="mt-2 border-l-2 border-halt bg-halt-soft px-3 py-2 text-[12px] leading-relaxed text-ink-2">
                  {r.error_reason}
                </p>
              )}

              {r.preview && (
                <details className="mt-2.5">
                  <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink">
                    추출된 원문 확인
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
                      <span className="text-[12px] text-measure">확정됨</span>
                      <Link
                        href={`/analysis/${r.case_id}`}
                        className="text-[12px] text-measure underline underline-offset-2"
                      >
                        분석 화면으로
                      </Link>
                    </>
                  ) : (
                    <form action={confirmCase}>
                      <input type="hidden" name="caseId" value={r.case_id} />
                      <button
                        type="submit"
                        className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft"
                      >
                        확인함 — 분석 대상으로
                      </button>
                    </form>
                  )}
                  <code className="addr text-[11px] text-ink-3">
                    npm run search -- --case {r.case_id}
                  </code>
                </div>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
