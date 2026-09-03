import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState, TermsNote, DoneBanner } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import {
  BoardToolbar, BoardPager, BoardTabs, SortHeader, parseBoard, type BoardParams,
} from '@/components/Board';
import { ActionForm } from '@/components/ActionForm';
import { AutoRefresh } from '@/components/AutoRefresh';
import { PageToc, type TocItem } from '@/components/PageToc';
import { runAnalysisAction } from '@/app/analysis/[caseId]/actions';

export const dynamic = 'force-dynamic';

const RECALLS_TOC: TocItem[] = [
  { id: 'recalls-status', label: '처리 현황' },
  { id: 'recalls-list', label: '리콜 목록' },
];

/**
 * 리콜 — 수집·현황·분석 (사고보고서와 분리)
 *
 * 왜 사고보고서와 다른 화면인가
 *   들어오는 경로가 다르다. 사고보고서는 사람이 PDF 를 올려 원문까지 확인해야
 *   하지만, 리콜은 협회가 운영하는 원본 표에서 자동으로 들어오고 위해요인 코드도
 *   이미 붙어 온다. 그래서 담당자가 봐야 할 숫자도 다르다 — 여기서 밀리는 것은
 *   "원문 확인"이 아니라 "국내 유통 확인"과 "분석 실행"이다.
 *
 * 게시판 형태인 이유
 *   지금 2,259건이고 앞으로 더 는다. 전부 쏟으면 찾을 수가 없다.
 *   찾기·정렬·쪽 넘김을 붙였고, 조건은 전부 주소줄에 있어 복사해 보낼 수 있다.
 *
 * 국내 유통 확인을 앞에 세우는 이유
 *   해외에서 리콜된 제품이 국내에도 유통됐는지는 시스템이 추정하지 않는다.
 *   제품안전기본법 13조 3항 보고의무 판단의 전제라서 담당자 확인 결과만 기록한다.
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
  fetched_at: string | null;
  domestic_check: string | null;
  detail_url: string | null;
  case_id: number | null;
  tag_count: number;
  embedded: boolean | null;
  embedding_pending: boolean | null;
  run_count: number;
  last_results: number | null;
}

const DISTRIBUTION_LABEL: Record<string, string> = {
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

async function load(params: BoardParams) {
  const db = getDb();
  const { q, per, offset, sort, dir, page } = parseBoard(params, 'published_on');
  const orderBy = SORTS[sort] ?? SORTS.published_on;
  const origin = params.origin ?? '';
  const check = params.check ?? '';

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

  const where = db`
    where true
      ${q ? db`and (rc.title ilike ${'%' + q + '%'} or rc.brand ilike ${'%' + q + '%'}
                    or rc.hazard_type ilike ${'%' + q + '%'}
                    or rc.recall_country ilike ${'%' + q + '%'})` : db``}
      ${origin ? db`and rc.origin = ${origin}` : db``}
      ${check ? db`and coalesce(rc.domestic_check, 'UNCHECKED') = ${check}` : db``}
  `;

  const [{ total }] = await db<{ total: number }[]>`
    select count(*)::int as total from public.recall_cache rc ${where}
  `;

  const rows = await db<RecallRow[]>`
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
        where r.case_id = rc.case_id order by r.started_at desc limit 1) as last_results
    from public.recall_cache rc
    left join public.case_event e on e.id = rc.case_id
    ${where}
    order by ${db.unsafe(orderBy)} ${db.unsafe(dir)} nulls last, rc.id desc
    limit ${per} offset ${offset}
  `;

  return { summary, rows, total, page, per };
}

/** 26.09.01. 처럼 붙여 쓴다. ko-KR 기본값은 "26. 09. 01." 로 공백이 들어간다 */
function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso)
    .toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' })
    .replace(/\s/g, '');
}

export default async function RecallsPage({
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
    console.error('리콜 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_10rem]">
      <div>
      <PageHead
        label="3 · 리콜"
        title="리콜과 안전기준 연계 분석"
        lead="해외·국내에서 리콜된 제품이 우리 안전기준의 어느 조항과 맞닿는지 찾아 드립니다. 리콜 자료는 협회 원본 표에서 저절로 들어오고 위해요인 코드도 붙어서 옵니다."
      />

      <DoneBanner message={done} />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          <div id="recalls-status" className="scroll-mt-8">
          <StatusBar
            items={[
              { label: '해외 리콜', value: data.summary.overseas, note: '협회 담당자가 승인한 것만 가져옵니다' },
              { label: '국내 리콜', value: data.summary.domestic, note: '국내에서 공고된 리콜' },
              {
                label: '국내 유통 확인 대기', value: data.summary.uncheckedDistribution, wantsZero: true,
                note: '해외에서 리콜된 제품이 국내에도 풀렸는지는 담당자가 직접 확인해야 합니다. 이걸 알아야 보고 의무가 있는지 따질 수 있습니다',
              },
              {
                label: '의미 검색 준비', value: data.summary.embedded, of: data.summary.cases,
                note: '단어가 달라도 뜻이 비슷한 조항까지 찾아냅니다. 새로 들어온 자료는 저절로 준비됩니다',
              },
              {
                label: '분석 실행됨', value: data.summary.analyzed, of: data.summary.cases,
                note: '관련될 수 있는 조항을 찾아 순위까지 매긴 리콜',
              },
              {
                // 담당자 요청으로 맨 뒤로 옮겼다 — 앞줄 끝에 혼자 남아 아랫줄이
                // 비어 보이던 자리를 메운다
                label: '위해요인 코드', value: data.summary.coded, of: data.summary.cases,
                note: '원인(HF)과 피해유형(DT) 코드가 붙은 리콜',
              },
            ]}
          />
          </div>

          {/* 준비가 밀려 있으면 숫자가 계속 바뀐다 — 새로고침을 사람이 누르지 않게 한다 */}
          <div className="mt-4">
            <AutoRefresh
              active={data.summary.embedded < data.summary.cases}
              seconds={20}
              label="의미 검색 준비가 진행 중입니다 — 숫자가 저절로 갱신됩니다"
            />
          </div>

          <BoardToolbar
            basePath="/recalls"
            params={params}
            placeholder="제품명·브랜드·위해유형·국가로 찾기"
            filters={[
              {
                name: 'check', label: '국내 유통',
                options: Object.entries(DISTRIBUTION_LABEL).map(([value, label]) => ({ value, label })),
              },
            ]}
          />

          {/* 해외·국내는 자주 바꿔 보는 구분이라 드롭다운 대신 단추로 뒀다(담당자 요청) */}
          <BoardTabs
            basePath="/recalls"
            params={params}
            name="origin"
            options={[
              { value: '', label: `전체 ${(data.summary.overseas + data.summary.domestic).toLocaleString()}` },
              { value: 'OVERSEAS', label: `해외 리콜 ${data.summary.overseas.toLocaleString()}` },
              { value: 'DOMESTIC', label: `국내 리콜 ${data.summary.domestic.toLocaleString()}` },
            ]}
          />

          {data.total === 0 ? (
            <EmptyState
              message={
                params.q || params.origin || params.check
                  ? '조건에 맞는 리콜이 없습니다. 찾기 조건을 지워 보세요.'
                  : '아직 가져온 리콜이 없습니다.'
              }
              commands={
                params.q || params.origin || params.check
                  ? undefined
                  : [{ cmd: 'npm run recalls:fetch', note: '협회가 승인한 리콜을 가져옵니다. 매일 새벽에 저절로도 돕니다' }]
              }
            />
          ) : (
            <section id="recalls-list" className="mt-6 scroll-mt-8">
              <div className="label grid grid-cols-[1fr_auto_auto_auto] gap-3 border-b border-rule pb-2">
                <SortHeader basePath="/recalls" params={params} field="title" label="리콜" />
                <SortHeader basePath="/recalls" params={params} field="domestic_check" label="국내 유통" />
                <SortHeader basePath="/recalls" params={params} field="published_on" label="발표일" align="right" />
                <SortHeader basePath="/recalls" params={params} field="fetched_at" label="가져온 날" align="right" />
              </div>

              {data.rows.map((r) => {
                const unchecked = !r.domestic_check || r.domestic_check === 'UNCHECKED';
                return (
                  <article key={r.id} className="border-b border-rule py-3">
                    <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-3">
                      <span className="text-[13px] font-medium">{r.title ?? '(제목 없음)'}</span>
                      <span className={`text-[11px] ${unchecked ? 'text-caution' : 'text-ink-3'}`}>
                        {DISTRIBUTION_LABEL[r.domestic_check ?? 'UNCHECKED']}
                      </span>
                      <span className="addr tnum text-right text-[11px] text-ink-3">
                        {when(r.published_on)}
                      </span>
                      <span className="addr tnum text-right text-[11px] text-ink-3">
                        {when(r.fetched_at)}
                      </span>
                    </div>

                    <div className="mt-1 text-[11px] leading-snug text-ink-3">
                      {r.origin === 'OVERSEAS' ? '해외' : '국내'}
                      {r.recall_country && ` · ${r.recall_country}`}
                      {r.brand && ` · ${r.brand}`}
                      {r.hazard_type && ` · ${r.hazard_type}`}
                      {r.tag_count > 0 && ` · 위해요인 코드 ${r.tag_count}`}
                      {r.embedded
                        ? ' · 의미 검색 준비됨'
                        : r.embedding_pending
                          ? ' · 의미 검색 준비 중…'
                          : ''}
                    </div>

                    {r.case_id && (
                      <div className="mt-2 flex flex-wrap items-center gap-3">
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
                );
              })}

              <BoardPager
                basePath="/recalls" params={params}
                total={data.total} page={data.page} per={data.per}
              />
            </section>
          )}
        </>
      )}

      <TermsNote />
      </div>
      <PageToc items={RECALLS_TOC} />
      </div>
    </div>
  );
}
