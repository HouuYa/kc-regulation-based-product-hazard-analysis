import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState, TermsNote, DoneBanner } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { runAnalysisAction } from '@/app/analysis/[caseId]/actions';

export const dynamic = 'force-dynamic';

/**
 * 리콜 — 수집·현황·분석 (담당자 요청으로 사고보고서에서 분리)
 *
 * 왜 사고보고서와 다른 화면인가
 *   들어오는 경로가 다르다. 사고보고서는 사람이 PDF 를 올려 원문까지 확인해야
 *   하지만, 리콜은 협회가 운영하는 원본 표에서 자동으로 들어오고 위해요인 코드도
 *   이미 붙어 온다(load-recalls.ts: "관리자가 이미 붙인 HF-DT 코드로 case_tag 를
 *   채운다. AI 호출 없음"). 그래서 담당자가 봐야 할 숫자도 다르다 —
 *   여기서 밀리는 것은 "원문 확인"이 아니라 "국내 유통 확인"과 "분석 실행"이다.
 *
 * 국내 유통 확인을 앞에 세우는 이유
 *   해외에서 리콜된 제품이 국내에도 유통됐는지는 시스템이 추정하지 않는다.
 *   제품안전기본법 13조 3항 보고의무 판단의 전제라서 담당자 확인 결과만 기록한다
 *   (013 마이그레이션 domestic_check 주석). 그래서 확인이 안 된 건수를 위에 띄운다.
 */

interface Summary {
  overseas: number;
  domestic: number;
  cases: number;
  coded: number;
  embedded: number;
  analyzed: number;
  uncheckedDistribution: number;
}

interface RecallRow {
  id: number;
  origin: string;
  title: string | null;
  brand: string | null;
  recall_country: string | null;
  hazard_type: string | null;
  published_on: string | null;
  domestic_check: string | null;
  detail_url: string | null;
  case_id: number | null;
  tag_count: number;
  embedded: boolean | null;
  run_count: number;
  last_results: number | null;
}

const DISTRIBUTION_LABEL: Record<string, string> = {
  UNCHECKED: '확인 안 함',
  DISTRIBUTED: '국내에도 유통됨',
  NOT_DISTRIBUTED: '국내 유통 없음',
  UNKNOWN: '확인했으나 알 수 없음',
};

async function load(): Promise<{ summary: Summary | null; rows: RecallRow[]; error: string | null }> {
  try {
    const db = getDb();

    const [summary] = await db<Summary[]>`
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

    const rows = await db<RecallRow[]>`
      select
        rc.id, rc.origin, rc.title, rc.brand, rc.recall_country, rc.hazard_type,
        rc.published_on::text, rc.domestic_check, rc.detail_url,
        rc.case_id,
        coalesce((select count(*)::int from public.case_tag t where t.case_id = rc.case_id), 0) as tag_count,
        (e.embedding is not null) as embedded,
        coalesce((select count(*)::int from public.match_run r where r.case_id = rc.case_id), 0) as run_count,
        (select r.result_count from public.match_run r
          where r.case_id = rc.case_id order by r.started_at desc limit 1) as last_results
      from public.recall_cache rc
      left join public.case_event e on e.id = rc.case_id
      order by rc.published_on desc nulls last, rc.id desc
      limit 50
    `;

    return { summary, rows, error: null };
  } catch (e) {
    console.error('리콜 화면 조회 실패:', e);
    return { summary: null, rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function RecallsPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const { done } = await searchParams;
  const { summary, rows, error } = await load();

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="3 · 리콜"
        title="리콜과 안전기준 연계 분석"
        lead="해외·국내에서 리콜된 제품이 우리 안전기준의 어떤 조항과 관련될 수 있는지 찾습니다. 리콜 자료는 협회 원본 표에서 자동으로 들어오며 위해요인 코드도 붙어 옵니다."
      />

      <DoneBanner message={done} />

      {error && <ConnectionError error={error} />}

      {summary && (
        <StatusBar
          items={[
            { label: '해외 리콜', value: summary.overseas, note: '원본 표에서 승인된 건만 가져옵니다' },
            { label: '국내 리콜', value: summary.domestic, note: '국내 리콜 공고' },
            {
              label: '국내 유통 확인 대기', value: summary.uncheckedDistribution, wantsZero: true,
              note: '해외 리콜 제품이 국내에도 유통됐는지는 담당자가 확인해야 합니다. 보고의무 판단의 전제입니다',
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
          ]}
        />
      )}

      {!error && rows.length === 0 && (
        <EmptyState
          message="아직 가져온 리콜이 없습니다."
          commands={[{ cmd: 'npm run recalls:fetch', note: '원본 표에서 승인된 리콜을 가져옵니다 (자동으로도 하루 1회 실행됩니다)' }]}
        />
      )}

      {rows.length > 0 && (
        <section className="mt-10">
          <h2 className="text-[15px] font-semibold">
            최근 리콜
            <span className="addr ml-2 text-[12px] font-normal text-ink-3">{rows.length}건 표시</span>
          </h2>
          <p className="mt-1 text-[12px] text-ink-3">
            발표일 최신순입니다. 전체 건수는 위 현황을 보세요.
          </p>

          {rows.map((r) => (
            <article key={r.id} className="border-t border-rule py-3.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-[13px] font-medium">{r.title ?? '(제목 없음)'}</span>
                <span className="addr tnum text-[11px] text-ink-3">
                  {r.origin === 'OVERSEAS' ? '해외' : '국내'}
                  {r.recall_country && ` · ${r.recall_country}`}
                  {r.published_on && ` · ${r.published_on.slice(0, 10)}`}
                </span>
              </div>

              <div className="mt-1 text-[11px] leading-snug text-ink-3">
                {r.brand && <span>{r.brand} · </span>}
                {r.hazard_type && <span>{r.hazard_type} · </span>}
                <span className={r.domestic_check === 'UNCHECKED' || !r.domestic_check ? 'text-caution' : ''}>
                  국내 유통 {DISTRIBUTION_LABEL[r.domestic_check ?? 'UNCHECKED']}
                </span>
                {r.tag_count > 0 && <span> · 위해요인 코드 {r.tag_count}</span>}
                {r.embedded && <span> · 의미 검색 준비됨</span>}
              </div>

              {r.case_id && (
                <div className="mt-2.5 flex flex-wrap items-center gap-3">
                  <Link
                    href={`/analysis/${r.case_id}`}
                    className="text-[12px] text-measure underline underline-offset-2"
                  >
                    이 리콜 분석 보기
                  </Link>
                  <form action={runAnalysisAction}>
                    <input type="hidden" name="caseId" value={r.case_id} />
                    <input type="hidden" name="returnTo" value="/recalls" />
                    <button
                      type="submit"
                      className="border border-rule px-3 py-1.5 text-[12px] hover:bg-measure-soft"
                    >
                      {r.run_count > 0 ? '분석 다시 실행' : '분석 실행'}
                    </button>
                  </form>
                  <span className="addr tnum text-[11px] text-ink-3">
                    {r.run_count > 0 ? `관련 조항 후보 ${r.last_results ?? 0}건` : '아직 분석하지 않음'}
                  </span>
                  {r.detail_url && (
                    <a
                      href={r.detail_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink"
                    >
                      원본 공고
                    </a>
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
