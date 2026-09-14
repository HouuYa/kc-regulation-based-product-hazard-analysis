import Link from 'next/link';
import { PageHead, ConnectionError, EmptyState, TermsNote, DoneBanner } from '@/components/Panel';
import { BoardToolbar, BoardPager, BoardTabs, SortHeader, type BoardParams } from '@/components/Board';
import { ActionForm } from '@/components/ActionForm';
import { PageToc, type TocItem } from '@/components/PageToc';
import { ScreenSwitch } from '@/components/ScreenSwitch';
import { ExternalLinkPreview } from '@/components/ExternalLinkPreview';
import { runAnalysisAction } from '@/app/analysis/[caseId]/actions';
import { GROUP_ORDER } from '@/lib/standards/label';
import { load, DISTRIBUTION_LABEL, when } from './data';

export const dynamic = 'force-dynamic';

const RECALLS_TOC: TocItem[] = [
  { id: 'recalls-list', label: '리콜 목록' },
];

/**
 * 리콜 — 처리할 것 (2026-09-14, 와이어프레임 1a)
 *
 * accidents/page.tsx 와 같은 개편이다 — 「현황」탭을 `/recalls/status` 로
 * 떼어내고, 이 페이지는 찾기·행별 작업만 남긴다. 조회는 `./data.ts` 에
 * 한 벌만 둔다.
 *
 * 왜 사고보고서와 다른 화면인가
 *   들어오는 경로가 다르다. 사고보고서는 사람이 PDF 를 올려 원문까지 확인해야
 *   하지만, 리콜은 협회가 운영하는 원본 표에서 자동으로 들어오고 위해요인 코드도
 *   이미 붙어 온다. 그래서 담당자가 봐야 할 숫자도 다르다 — 여기서 밀리는 것은
 *   "원문 확인"이 아니라 "국내 유통 확인"과 "분석 실행"이다.
 */
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
      <PageHead
        label="3 · 리콜"
        title="리콜과 안전기준 연계 분석"
        lead="리콜 자료를 확인하고 국내 유통 여부를 기록한 뒤, 관련될 수 있는 안전기준을 찾습니다."
        workflow={data ? [
          {
            label: '리콜 수집',
            note: `${(data.summary.overseas + data.summary.domestic).toLocaleString()}건`,
            state: 'done',
          },
          {
            label: '위해요인 코드',
            note: `${data.summary.coded.toLocaleString()} / ${data.summary.cases.toLocaleString()}`,
            state: data.summary.coded < data.summary.cases ? 'here' : 'done',
          },
          {
            label: '뜻 검색 준비',
            note: `${data.summary.embedded.toLocaleString()} / ${data.summary.cases.toLocaleString()}`,
            state: data.summary.embedded < data.summary.cases ? 'here' : 'done',
          },
          {
            label: '분석',
            who: '사람',
            note: `${data.summary.analyzed.toLocaleString()} / ${data.summary.cases.toLocaleString()}`,
            state: 'here',
          },
          {
            label: '국내 유통 확인',
            who: '사람',
            note: `미확인 ${data.summary.uncheckedDistribution.toLocaleString()}`,
            state: 'todo',
          },
        ] : undefined}
      />

      <ScreenSwitch
        options={[
          { href: '/recalls', label: '처리할 것' },
          { href: '/recalls/status', label: '현황' },
        ]}
      />

      <DoneBanner message={done} />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
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

          {/* 대분류 — 담당자는 대개 한 대분류만 맡는다(2026-09-09) */}
          <BoardTabs
            basePath="/recalls"
            params={params}
            name="group"
            options={GROUP_ORDER.map((g) => ({
              value: g,
              label: `${g} ${(data.groupCount.get(g) ?? 0).toLocaleString()}`,
            }))}
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            대분류는 서류의 제품명을{' '}
            <Link href="/terms" className="underline decoration-rule underline-offset-2">품목 용어 사전</Link>
            으로 옮겨 얻습니다. 사전에 아직 없는 이름은 <span className="text-ink-2">기타</span>로 둡니다 —
            사전이 자라면 저절로 제자리를 찾습니다.
          </p>

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
                {/*
                  담당자 지적(2026-09-14): "발표일이냐 공표일이냐 중요해서 공표일
                  시점으로" — 리콜 당국이 공고를 낸 시점이라는 뜻을 정확히 담는
                  법령 용어로 바꿨다. "가져온 날"도 "이 시스템이 조회한 날"이라는
                  뜻이 label만으론 안 드러난다는 지적에 "수집일"로 좁혔다.
                */}
                <SortHeader basePath="/recalls" params={params} field="published_on" label="공표일" align="right" />
                <SortHeader basePath="/recalls" params={params} field="fetched_at" label="수집일" align="right" />
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
                      <span className={r.item_group ? 'text-ink-2' : 'text-ink-3'}>
                        {r.item_group ?? '기타'}
                      </span>
                      {' · '}
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
                          <ExternalLinkPreview
                            href={r.detail_url}
                            label="원본 공고"
                            className="text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink"
                          />
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
      <PageToc items={RECALLS_TOC} />
    </div>
  );
}
