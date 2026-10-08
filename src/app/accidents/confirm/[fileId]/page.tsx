import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getSignedUrl } from '@/lib/supabase/server';
import { ActionForm } from '@/components/ActionForm';
import { StageAnnouncer } from '@/components/StageContext';
import { confirmCase } from '../../actions';

export const dynamic = 'force-dynamic';

/**
 * 원문 확인 — 원본 PDF 와 뽑아낸 글자를 나란히 (05_02 P1-3, 2026-10-07)
 *
 * 전에는 목록 안의 접힘 칸에 뽑아낸 글자 앞 420자만 보여 주고 "표가 뭉개지지
 * 않았는지 보고 눌러 주세요"라고 했다. 420자로는 표까지 가지도 못한다 — 71건 중
 * 65건이 7일 넘게 확인을 기다린 직접 원인으로 보았다(05 §2.4).
 *
 * 그래서 확인을 목록에서 떼어 이 화면으로 옮겼다. 왼쪽은 보관해 둔 원본, 오른쪽은
 * 분석에 실제로 쓰일 글자 전문이다. 확인하면 다음 대기 건으로 바로 넘어갈 수 있다.
 */
export default async function ConfirmPage({ params }: { params: Promise<{ fileId: string }> }) {
  const fileId = Number((await params).fileId);
  if (!Number.isInteger(fileId)) notFound();

  const db = getDb();
  const [row] = await db<{
    filename: string; page_count: number | null; extracted_text: string | null;
    storage_path: string | null; case_id: number | null; is_confirmed: boolean | null;
  }[]>`
    select f.filename, f.page_count, f.extracted_text, f.storage_path, e.id::int as case_id, e.is_confirmed
    from public.source_file f
    left join public.case_event e on e.source_file_id = f.id
    where f.id = ${fileId} and f.kind = 'ACCIDENT_PDF'
  `;
  if (!row) notFound();

  // 다음 확인 대기 — 올린 순서대로. 지금 건은 빼고 찾는다
  const [next] = await db<{ id: number }[]>`
    select f.id::int from public.source_file f
    join public.case_event e on e.source_file_id = f.id
    where f.kind = 'ACCIDENT_PDF' and not e.is_confirmed and f.id <> ${fileId}
    order by f.uploaded_at, f.id limit 1
  `;

  let pdfUrl: string | null = null;
  if (row.storage_path) {
    try {
      pdfUrl = await getSignedUrl(row.storage_path, 1800);
    } catch (e) {
      console.error('원본 서명 URL 발급 실패:', e);
    }
  }

  return (
    <div className="mx-auto max-w-[96rem] px-6 py-8 lg:px-10">
      <StageAnnouncer stage="/accidents" />
      <Link href="/accidents" className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink">
        ← 사고보고서 목록
      </Link>
      <h1 className="mt-2 text-[20px] leading-snug font-semibold tracking-tight">{row.filename}</h1>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
        왼쪽 원본과 오른쪽 글자를 견주어, 표·숫자가 뭉개지거나 빠지지 않았는지 봅니다.
        오른쪽 글자가 그대로 분석에 쓰입니다. 다르면 확인하지 말고 원본을 다시 올려 주세요.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3 border border-rule bg-surface px-4 py-3">
        {row.case_id == null ? (
          <span className="text-[12px] text-halt">이 파일은 분석 대상으로 만들어지지 않았습니다(추출 오류). 목록에서 사유를 보세요.</span>
        ) : row.is_confirmed ? (
          <span className="text-[12px] text-measure">원문 확인을 마친 보고서입니다.</span>
        ) : (
          <ActionForm
            action={confirmCase}
            hidden={{ caseId: row.case_id }}
            label="원문이 맞습니다 — 분석 대상으로"
            pendingLabel="처리하는 중…"
            className="border border-measure bg-measure px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
          />
        )}
        {row.case_id != null && row.is_confirmed && (
          <Link href={`/analysis/${row.case_id}`} className="text-[12px] text-measure underline underline-offset-2">
            분석 화면으로
          </Link>
        )}
        <span className="flex-1" />
        {next ? (
          <Link href={`/accidents/confirm/${next.id}`} className="text-[12px] text-measure underline underline-offset-2">
            다음 확인 대기 →
          </Link>
        ) : (
          <span className="text-[12px] text-ink-3">확인을 기다리는 다른 보고서가 없습니다</span>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section aria-label="원본 PDF" className="border border-rule">
          <div className="label border-b border-rule-soft px-3 py-2">원본{row.page_count ? ` · ${row.page_count}쪽` : ''}</div>
          {pdfUrl ? (
            <iframe src={pdfUrl} title="원본 PDF" className="h-[78vh] w-full" />
          ) : (
            <p className="px-3 py-6 text-[12px] text-caution">
              원본이 보관돼 있지 않아 나란히 볼 수 없습니다. 원문 역추적이 안 되는 자료입니다.
            </p>
          )}
        </section>
        <section aria-label="뽑아낸 글자" className="border border-rule">
          <div className="label border-b border-rule-soft px-3 py-2">
            뽑아낸 글자 · {(row.extracted_text?.length ?? 0).toLocaleString()}자
          </div>
          <pre className="h-[78vh] overflow-auto px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">
            {row.extracted_text ?? '(뽑아낸 글자가 없습니다)'}
          </pre>
        </section>
      </div>
    </div>
  );
}
