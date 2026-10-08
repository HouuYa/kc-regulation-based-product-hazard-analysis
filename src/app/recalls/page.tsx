import Link from 'next/link';
import { PageHead, ConnectionError, EmptyState, TermsNote, DoneBanner } from '@/components/Panel';
import { BoardToolbar, BoardPager, BoardTabs, SortHeader, type BoardParams } from '@/components/Board';
import { ActionForm } from '@/components/ActionForm';
import { ExternalLinkPreview } from '@/components/ExternalLinkPreview';
import { runAnalysisAction } from '@/app/analysis/[caseId]/actions';
import { GROUP_ORDER } from '@/lib/standards/label';
import { listProductScopes } from '@/lib/cases/manual-scope';
import { scopeMethodOf } from '@/lib/cases/classified';
import { load, DISTRIBUTION_LABEL, when } from './data';
import { DomesticCheckButtons, ScopePicker } from './Triage';

export const dynamic = 'force-dynamic';

/**
 * 리콜 분석 작업공간 — 1단계 국내 관련성 / 2단계 조항 연계 (05_02 P3-1, 2026-10-07)
 *
 * 담당자 결정: "리콜 분석자가 둘 다 할 수 있도록 하되, 두 단계를 구분"
 *   1단계는 이 해외 리콜이 국내와 관계있는지를 가린다 — 품목(적용 기준)을 정하고
 *   국내 유통 여부를 기록한다. 전에는 이 두 값을 넣을 버튼이 없어 2,399건 전부가
 *   미확인·대부분 품목 미정으로 남았다.
 *   2단계는 관련될 수 있는 조항을 찾고 채택한다. 품목이 정해지지 않으면 분석이
 *   "적용 기준 미확정"으로 멈추므로, 2단계는 품목이 정해진 리콜부터 보여 준다.
 *
 * 진척 숫자(코드·의미 검색 준비 등)는 관리 콘솔로 옮겼다 — 이 화면은 결정하는 자리다.
 * 전의 `/recalls/status` 는 넘겨주기만 남았다.
 */
type Stage = '' | 'link';

export default async function RecallsPage({
  searchParams,
}: {
  searchParams: Promise<BoardParams & { done?: string }>;
}) {
  const raw = await searchParams;
  const stage: Stage = raw.stage === 'link' ? 'link' : '';
  // 2단계는 처음 열 때 품목이 정해진 것만 본다 — 정해지지 않은 리콜은 분석해도 멈춘다
  const params: BoardParams = stage === 'link' && raw.scope === undefined ? { ...raw, scope: 'set' } : raw;
  const { done } = raw;

  let data: Awaited<ReturnType<typeof load>> | null = null;
  let scopes: Awaited<ReturnType<typeof listProductScopes>> = [];
  let error: string | null = null;
  try {
    [data, scopes] = await Promise.all([load(params), stage === '' ? listProductScopes() : Promise.resolve([])]);
  } catch (e) {
    console.error('리콜 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  const filtered = Boolean(params.q || params.origin || params.check || params.group || params.scope);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="업무 · 리콜 분석"
        title="리콜이 국내와 관계있는지 가리고, 관련 조항을 찾습니다"
        lead="1단계에서 국내 유통 여부를 기록하고(품목은 자동 판정·원본 분류가 차려 두었으니 확인만, 비어 있는 것만 정하고), 2단계에서 관련될 수 있는 안전기준 조항을 찾아 채택합니다. 두 단계 모두 이 화면에서 합니다."
        workflow={data ? [
          { label: '리콜 수집', note: `${data.summary.cases.toLocaleString()}건`, state: 'done' },
          {
            label: '1단계 품목 분류', who: '사람', href: '/recalls?scope=unset',
            note: `${data.summary.scoped.toLocaleString()} / ${data.summary.cases.toLocaleString()}`,
            state: stage === '' ? 'here' : 'done',
          },
          {
            label: '1단계 국내 유통 확인', who: '사람', href: '/recalls?check=UNCHECKED',
            note: `미확인 ${data.summary.uncheckedDistribution.toLocaleString()}`,
            state: stage === '' ? 'here' : 'done',
          },
          {
            label: '2단계 조항 찾기·채택', who: '사람', href: '/recalls?stage=link',
            note: `분석 ${data.summary.analyzed.toLocaleString()}`,
            state: stage === 'link' ? 'here' : 'todo',
          },
        ] : undefined}
      />

      <BoardTabs
        basePath="/recalls"
        params={{ ...raw, scope: undefined }}
        name="stage"
        options={[
          { value: '', label: '1단계 · 국내 관련성' },
          { value: 'link', label: '2단계 · 조항 연계' },
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
            hidden={{ stage: stage || undefined, origin: params.origin, group: params.group }}
            filters={[
              {
                name: 'check', label: '국내 유통',
                options: Object.entries(DISTRIBUTION_LABEL).map(([value, label]) => ({ value, label })),
              },
              {
                name: 'scope', label: '품목',
                options: [{ value: 'unset', label: '미분류만' }, { value: 'set', label: '분류됨(원본·담당자)' }],
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
            <Link href="/dictionary?tab=term" className="underline decoration-rule underline-offset-2">품목 판정 사전</Link>
            으로 옮겨 얻습니다. 사전에 아직 없는 이름은 <span className="text-ink-2">기타</span>로 둡니다.
          </p>

          {data.total === 0 ? (
            <EmptyState
              message={
                filtered
                  ? '조건에 맞는 리콜이 없습니다. 찾기 조건을 지워 보세요.'
                  : '아직 가져온 리콜이 없습니다. 매일 새벽에 저절로 가져옵니다.'
              }
            />
          ) : (
            <section id="recalls-list" className="mt-6 scroll-mt-8">
              <div className="label grid grid-cols-[1fr_auto_auto] gap-3 border-b border-rule pb-2">
                <SortHeader basePath="/recalls" params={params} field="title" label="리콜" />
                {/*
                  담당자 지적(2026-09-14): "발표일이냐 공표일이냐 중요해서 공표일
                  시점으로" — 리콜 당국이 공고를 낸 시점이라는 뜻을 정확히 담는
                  법령 용어다. "수집일"은 이 시스템이 조회한 날이다.
                */}
                <SortHeader basePath="/recalls" params={params} field="published_on" label="공표일" align="right" />
                <SortHeader basePath="/recalls" params={params} field="fetched_at" label="수집일" align="right" />
              </div>

              {data.rows.map((r) => (
                <article key={r.id} className="border-b border-rule py-3">
                  <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3">
                    <span className="text-[13px] font-medium">{r.title ?? '(제목 없음)'}</span>
                    <span className="addr tnum text-right text-[11px] text-ink-3">{when(r.published_on)}</span>
                    <span className="addr tnum text-right text-[11px] text-ink-3">{when(r.fetched_at)}</span>
                  </div>

                  <div className="mt-1 text-[11px] leading-snug text-ink-3">
                    <span className={r.item_group ? 'text-ink-2' : 'text-ink-3'}>{r.item_group ?? '기타'}</span>
                    {' · '}
                    {r.origin === 'OVERSEAS' ? '해외' : '국내'}
                    {r.recall_country && ` · ${r.recall_country}`}
                    {r.brand && ` · ${r.brand}`}
                    {r.hazard_type && ` · ${r.hazard_type}`}
                    {' · 품목 '}
                    {/*
                      품목은 대부분 이미 차려져 있다 (2026-10-07) — 담당자 지정 > 자동 판정(수집 배치가
                      사전·적용범위·의미 검색으로 찾은 것) > 원본 GPC. 셋 다 없을 때만 「미분류」다.
                      정의는 lib/cases/classified.ts 한 곳에 있다.
                    */}
                    {r.scope_manual && r.scope_name ? (
                      <span className="text-ink-2">{r.scope_name} (담당자 지정)</span>
                    ) : r.scope_evidence ? (
                      <span className="text-ink-2" title={r.scope_evidence}>
                        {r.scope_name ?? r.gpc_title ?? '적용 기준 찾음'} ({scopeMethodOf(r.scope_evidence)} · 자동 판정)
                      </span>
                    ) : r.gpc_brick_code ? (
                      // 원본 DB 가 보낸 분류 그대로 — 검토 대상이 아니다(2026-10-07 담당자 요청)
                      <span className="text-ink-2" title={`GPC ${r.gpc_brick_code}`}>
                        {r.gpc_title ?? `GPC ${r.gpc_brick_code}`} (원본 분류)
                      </span>
                    ) : (
                      <span className="text-caution">미분류</span>
                    )}
                    {' · 국내 유통 '}
                    <span className={!r.domestic_check || r.domestic_check === 'UNCHECKED' ? 'text-caution' : 'text-ink-2'}>
                      {DISTRIBUTION_LABEL[r.domestic_check ?? 'UNCHECKED']}
                    </span>
                  </div>

                  {r.case_id && stage === '' && (
                    <div className="mt-2 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="label w-16">국내 유통</span>
                        <DomesticCheckButtons caseId={r.case_id} current={r.domestic_check} />
                      </div>
                      {/*
                        품목 고르기는 분류가 없을 때만 펼쳐 둔다 — 원본 분류가 있으면 그대로 쓰고,
                        담당자가 다르게 봐야 할 때만 접힌 칸을 연다(사람이 정한 것이 원본을 이긴다).
                      */}
                      {r.product_scope_id == null && r.scope_evidence == null && r.gpc_brick_code == null ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="label w-16">품목</span>
                          <div className="min-w-0 flex-1">
                            <ScopePicker caseId={r.case_id} currentId={r.product_scope_id} options={scopes} />
                          </div>
                        </div>
                      ) : (
                        <details>
                          <summary className="cursor-pointer text-[11px] text-ink-3 hover:text-ink">품목을 다르게 정하기</summary>
                          <div className="mt-1.5">
                            <ScopePicker caseId={r.case_id} currentId={r.product_scope_id} options={scopes} />
                          </div>
                        </details>
                      )}
                    </div>
                  )}

                  {r.case_id && (
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <Link href={`/analysis/${r.case_id}`} className="text-[12px] text-measure underline underline-offset-2">
                        상세 보기
                      </Link>
                      {stage === 'link' && (
                        <>
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
                        </>
                      )}
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
              ))}

              <BoardPager basePath="/recalls" params={params} total={data.total} page={data.page} per={data.per} />
            </section>
          )}
        </>
      )}

      <TermsNote />
    </div>
  );
}
