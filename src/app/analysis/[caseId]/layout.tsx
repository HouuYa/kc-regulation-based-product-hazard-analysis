import Link from 'next/link';
import { FlowChart } from '@/components/Panel';
import { ActionForm } from '@/components/ActionForm';
import { RecallOverview } from '@/components/RecallOverview';
import { StageAnnouncer } from '@/components/StageContext';
import { standardName } from '@/lib/standards/label';
import { loadRecallOverview } from '@/lib/recall/overview';
import { listProductScopes, MANUAL_SCOPE_PREFIX } from '@/lib/cases/manual-scope';
import { GPC_SOURCE_LABEL, needsReview, type GpcSource } from '@/lib/gpc/provenance';
import { DomesticCheckButtons, ScopePicker } from '@/app/recalls/Triage';
import { load } from './data';
import { setChildProductCheck } from './actions';

/**
 * 사건 분석 — 공통 헤더 (2026-09-14, 와이어프레임 1a)
 *
 * 사건 요약, 품목·적용기준(품목 지정·어린이제품 확정 버튼 포함), 리콜이면 국내
 * 유통 확인을 그린다. 2026-10-07 인사이트 화면을 검토 화면에 합치면서(05_02 P2-1)
 * 두 화면을 오가던 링크는 뺐다 — 옛 설계 근거는
 * docs/화면_구조_개편_검토_인사이트_분리_2026-09-12.md §3.1.
 *
 * 품목 지정·국내 유통 확인을 여기 두는 이유 (05_02 P1-1·P1-2)
 *   둘 다 리콜 분석자 1단계 「국내 관련성」의 판단이고, 품목은 아래 조항 후보를
 *   좌우하는 전제다. 어린이제품 확정 버튼을 이 자리에 둔 것과 같은 이유다.
 *
 * 어린이제품 확정 버튼을 여기 남기는 이유
 *   이 결정은 적용 기준 자체를 바꾸는 전제 조건이라, 검토 화면 안으로 옮기면
 *   "품목·적용기준"과 "그걸 바꾸는 버튼"이 떨어져 오히려 헷갈린다(위 설계문서 §3.1).
 *
 * `?done=`(DoneBanner)을 여기서 안 그리는 이유
 *   레이아웃은 searchParams 를 받지 못한다(Next.js 규칙) — 각 페이지가 자기
 *   searchParams 로 직접 그린다.
 *
 * 사건을 못 찾거나 조회가 실패하면 `children` 을 그리지 않고 여기서 바로
 * 안내를 보여 준다 — 두 화면 모두 같은 처리가 필요하므로 한 번만 적는다.
 */

/** 어린이제품 여부 — 확인하지 않은 것과 아니라고 확인한 것은 다른 상태다(055) */
const CHILD_CHECK_LABEL: Record<string, string> = {
  UNCHECKED: '미확인 — 담당자 확인 필요',
  CHILD: '어린이제품 (공통안전기준 적용)',
  NOT_CHILD: '어린이제품 아님',
  UNKNOWN: '확인했지만 알아내지 못함',
};

export default async function AnalysisLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ caseId: string }>;
}) {
  const { caseId: raw } = await params;
  const caseId = Number(raw);

  let data: Awaited<ReturnType<typeof load>> = null;
  let error: string | null = null;
  try {
    data = await load(caseId);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10">
        <div className="border border-halt bg-halt-soft px-5 py-4 text-[13px] text-halt">
          데이터를 불러오지 못했습니다. <span className="addr text-ink-2">{error}</span>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10">
        <p className="text-[13px] text-ink-2">사건 {raw} 이 없습니다.</p>
        <Link href="/accidents" className="mt-2 inline-block text-[13px] text-measure underline">
          사고보고서 목록으로
        </Link>
      </div>
    );
  }

  const { ev, tags, run, results, standards, photos, recall } = data;
  const scopeOptions = await listProductScopes();
  const scopeManual = ev.scope_evidence?.startsWith(MANUAL_SCOPE_PREFIX) ?? false;

  /*
    리콜 개요 (2026-09-14, 담당자 지적)

    리콜 사건의 narrative는 API 필드를 이어붙인 문장이라 사람이 쓴 사고보고서
    서술과 다르다 — 그걸 그대로 "원문 전체 보기"로 펼치면 읽기 어렵다. 표+사진
    개요가 있으면 그것을 쓰고, 없으면(원본이 아직 안 실렸거나 국내 리콜처럼
    다른 파이프라인인 경우) 기존 narrative 미리보기로 물러난다.
  */
  const recallOverview = ev.source_type !== 'ACCIDENT' ? await loadRecallOverview(caseId) : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      {/*
        좌측 메뉴에 "지금 여기"를 알려 준다 (2026-09-14, 담당자 요청) — 사고
        보고서인지 리콜인지는 이 라우트만 알 수 있으므로, 여기서 SideNav 에
        직접 흘려보낸다. 자세한 이유는 components/StageContext.tsx 를 본다.
      */}
      <StageAnnouncer stage={ev.source_type === 'ACCIDENT' ? '/accidents' : '/recalls'} />
      <header id="analysis-case" className="scroll-mt-8">
        {/* 사건번호는 뺐다(담당자 요청) — 내부 식별자일 뿐 담당자가 쓸 일이 없다 */}
        <div className="label">
          {ev.source_type === 'ACCIDENT' ? '사고보고서' : '리콜'}
          {ev.occurred_on && ` · ${ev.occurred_on}`}
        </div>
        <h1 className="mt-2 max-w-2xl text-[24px] leading-snug font-semibold tracking-tight">
          {ev.title ?? ev.narrative.slice(0, 60)}
        </h1>
        {/*
          이 화면의 일 순서를 다른 화면과 같은 모양의 순서도로 (담당자 요청, 2026-09-09)
          원본은 docs/전체_프로세스와_용어.md §3 의 C1~D1 구간이다.
        */}
        <FlowChart
          steps={[
            { label: '사건 내용', href: '#analysis-case', state: 'done' },
            {
              label: '품목·기준 확정',
              href: '#analysis-scope',
              note: standards.length > 0 ? `기준 ${standards.length}종` : '미확정 — 여기서 멈춤',
              state: standards.length > 0 ? 'done' : 'here',
            },
            {
              label: '조항 후보 찾기',
              href: `/analysis/${caseId}#analysis-results`,
              note: run ? `${results.length}건` : '아직 실행 안 함',
              state: run ? 'done' : 'here',
            },
            {
              label: '채택·반려',
              who: '사람',
              note: `${results.filter((r) => r.decision != null).length} / ${results.length}`,
              state: 'here',
            },
            { label: '산출물', href: '/policy', note: '시험항목·개선요인', state: 'todo' },
          ]}
        />
        {recallOverview ? (
          /*
            리콜 개요 — 표 + 사진 (2026-09-14, 담당자 요청)
            자세한 이유는 위 recallOverview 주석과 components/RecallOverview.tsx 를 본다.
          */
          <div className="mt-3 max-w-2xl">
            <RecallOverview data={recallOverview} />
          </div>
        ) : (
          /*
            원문을 접어 둔다 (담당자 요청: "사고보고서 분석 페이지가 너무 길어요")

            사고조사보고서는 PDF 에서 뽑은 글자를 통째로 담고 있어 한 건이 수천 자다.
            그것을 펼쳐 두면 정작 봐야 할 「관련될 수 있는 조항」이 화면 한참 아래로
            밀린다. 첫 두 줄만 보이고 필요할 때 펼치게 한다 —
            원문 확인은 등록 단계에서 이미 한 번 하는 일이다.
          */
          <details className="mt-3 max-w-2xl">
            <summary className="cursor-pointer list-none">
              <span className="block text-[13px] leading-relaxed text-ink-2">
                {ev.narrative.slice(0, 160)}
                {ev.narrative.length > 160 && '…'}
              </span>
              <span className="mt-1 inline-block text-[11px] text-ink-3 hover:text-ink">
                {ev.source_type === 'ACCIDENT' ? '사고보고서' : '리콜'} 원문 전체 보기 ({ev.narrative.length.toLocaleString()}자)
              </span>
            </summary>
            <p className="mt-2 border-l-2 border-rule pl-3 text-[12px] leading-relaxed whitespace-pre-line text-ink-2">
              {ev.narrative}
            </p>
          </details>
        )}

        {/*
          사고사진 (068) — 텍스트만으로는 원인을 못 찾은 사건에서 실제로 단서가
          여기 있었다(실측: 전기방석 사건, 텍스트는 "시험 적합"뿐이었지만 사진에는
          전선 피복 손상이 보였다). 아직 비전 분석 전이면(analyzed_at null)
          "분석 대기"만 표시한다 — /ops 에서 켜야 도는 배치 작업이다.
        */}
        {photos.length > 0 && (
          <details className="mt-3 max-w-2xl">
            <summary className="cursor-pointer list-none text-[11px] text-ink-3 hover:text-ink">
              첨부 사진 {photos.length}장 보기
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {photos.map((p) => (
                <div key={p.id} className="border border-rule-soft p-2">
                  {p.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 서명 URL은 매 렌더 새로 발급돼 next/image 캐시와 안 맞는다
                    <img src={p.url} alt={`${p.page_number}쪽 사진`} className="w-full object-contain" />
                  ) : (
                    <div className="flex h-24 items-center justify-center text-[11px] text-ink-3">
                      이미지를 불러오지 못했습니다
                    </div>
                  )}
                  <div className="mt-1.5 text-[11px] text-ink-3">{p.page_number}쪽</div>
                  {p.analyzed_at ? (
                    <>
                      {p.is_relevant_photo === false && (
                        <div className="text-[11px] text-ink-3">장식·서식 이미지로 판정됨</div>
                      )}
                      {p.description && (
                        <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{p.description}</p>
                      )}
                      {p.hazard_note && (
                        <p className="mt-1 text-[11px] leading-relaxed text-caution">⚠ {p.hazard_note}</p>
                      )}
                    </>
                  ) : (
                    <div className="mt-1 text-[11px] text-ink-3">분석 대기 중</div>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="label mr-1">붙은 코드</span>
          {tags.length === 0 && <span className="text-[12px] text-caution">코드화되지 않음</span>}
          {tags.map((t) => (
            <span
              key={`${t.axis}${t.code}`}
              className={`addr border px-1.5 py-0.5 text-[11px] ${
                t.is_primary ? 'border-measure text-measure' : 'border-rule text-ink-2'
              }`}
            >
              {t.code}
            </span>
          ))}
        </div>
      </header>

      {/*
        국내 유통 확인 (05_02 P1-1) — 미확인은 붉은 박스(2026-09-14 담당자 요청, 어린이제품
        여부와 같은 규칙). 「제품안전기본법」 제13조 제3항 보고의무 판단의 전제다.
      */}
      {recall && (
        <section
          id="analysis-domestic"
          className={`mt-6 border px-4 py-3 ${recall.domestic_check === 'UNCHECKED' ? 'border-halt bg-halt-soft' : 'border-rule-soft'}`}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="label">국내에도 풀렸는가</span>
            <DomesticCheckButtons caseId={caseId} current={recall.domestic_check} />
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            같은 제품이 국내에도 풀린 것으로 확인되면, 「제품안전기본법」 제13조 제3항에 따라
            사업자가 곧바로 보고해야 하는지 따져 봐야 합니다. 이 시스템은 국내에 풀렸는지를
            스스로 짐작하지 않습니다.
          </p>
        </section>
      )}

      {/* 품목·적용기준 — 검색보다 먼저 결정되는 것이므로 후보 목록보다 위에 둔다 */}
      <section id="analysis-scope" className="mt-6 scroll-mt-8 border-t border-rule pt-5">
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <span className="label">품목·적용기준</span>
          <div className="text-[13px] leading-relaxed">
            {ev.product_scope_id || ev.item_name ? (
              <>
                <div>
                  <span className="font-medium">{ev.scope_name ?? ev.item_name}</span>
                  {ev.basis_date && (
                    <span className="ml-2 text-[11px] text-ink-3">기준일 {ev.basis_date}</span>
                  )}
                </div>
                {ev.scope_evidence && (
                  <p className="mt-1 text-[12px] text-ink-2">{ev.scope_evidence}</p>
                )}
                {/* 원본 DB 가 보낸 품목분류 — 그대로 쓴다(2026-10-07, resolve-scope.ts resolveByGpcBrick) */}
                {ev.gpc_brick_code && !needsReview(ev.gpc_source) && (
                  <p className="mt-1 text-[12px] text-ink-2">
                    원본 품목분류 <span className="addr">GPC {ev.gpc_brick_code}</span>
                    <span className="ml-1 text-ink-3">({GPC_SOURCE_LABEL[ev.gpc_source as GpcSource] ?? ev.gpc_source})</span>
                  </p>
                )}
                {standards.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {standards.map((s) => {
                      const { name } = standardName(s);
                      return (
                        <span key={s.display_name} className="border border-rule px-1.5 py-0.5 text-[11px] text-ink-2">
                          {name && <span className="mr-1">{name}</span>}
                          <span className="addr text-ink-3">{s.display_name}</span>
                          {s.relation && <span className="ml-1 text-ink-3">{s.relation === 'ANNEX' ? '부속서' : '공통'}</span>}
                        </span>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <div className="border border-caution bg-caution-soft px-3 py-2 text-[12px] leading-relaxed text-caution">
                <strong className="font-semibold">품목 미확정</strong>
                <p className="mt-1">
                  적용 기준을 정하지 못해 분석하지 않습니다 — 전 품목으로 찾으면 다른 제품의
                  시험이 섞이기 때문입니다. 아래에서 품목을 정한 뒤 분석을 실행해 주세요.
                </p>
              </div>
            )}

            {/* 품목 지정 (05_02 P1-2) — 정하면 다음 수집이 덮지 않는다(lib/cases/manual-scope.ts) */}
            <div className="mt-3">
              {scopeManual && <div className="mb-1 text-[11px] text-ink-3">담당자가 정한 품목입니다.</div>}
              <ScopePicker caseId={caseId} currentId={ev.product_scope_id} options={scopeOptions} />
            </div>

            {/*
              어린이제품인가 — 사람이 정하고, 정하면 적용 기준이 바뀐다 (055)

              가이드라인의 결정요소(사용연령 표시·포장 문구·판매 구역 …)는 실물을 봐야
              판정된다. 그래서 시스템은 추정하지 않고 받아 적는다. 확정하면 어린이제품
              공통안전기준이 적용 기준에 들어가고(유해원소·프탈레이트·자석·작은 부품),
              아니라고 하면 자동 판정이 붙였더라도 뺀다.
            */}
            {/*
              미확인(UNCHECKED)은 붉은 박스로 표시한다 (2026-09-14, 담당자 요청)

              "담당자 검토가 필요한 경우, 붉은 박스로 표시하면 좋을 듯" — 확인이
              필요한 상태와 확인을 마친 상태(어린이제품/아님/알아내지 못함)를
              색만이 아니라 테두리로도 갈라야 눈에 먼저 띈다.
            */}
            <div className={`mt-4 border px-3 py-2.5 ${
              ev.child_product_check === 'UNCHECKED'
                ? 'border-halt bg-halt-soft'
                : 'border-rule-soft'
            }`}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="label">어린이제품 여부</span>
                <span className={`text-[12px] font-medium ${
                  ev.child_product_check === 'CHILD' ? 'text-measure'
                  : ev.child_product_check === 'NOT_CHILD' ? 'text-ink-2'
                  : ev.child_product_check === 'UNCHECKED' ? 'text-halt'
                  : 'text-caution'}`}
                >
                  {CHILD_CHECK_LABEL[ev.child_product_check] ?? '미확인'}
                </span>
              </div>

              {ev.child_product_note && (
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                  근거: {ev.child_product_note}
                </p>
              )}

              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
                만 13세 이하 어린이가 쓰거나 어린이를 위해 쓰는 물품이면 어린이제품입니다.
                포장·광고·사용연령 표시·판매 구역을 보고 정합니다(「어린이제품 가이드라인」 고시).
                <strong className="font-semibold"> 어린이제품으로 정하면 공통안전기준이 적용 기준에 들어갑니다</strong> —
                유해원소·프탈레이트·자석·작은 부품은 부속서가 아니라 그 기준에만 있습니다.
              </p>

              <div className="mt-2.5">
              <ActionForm
                action={setChildProductCheck}
                hidden={{ caseId }}
                buttonField="value"
                buttons={[
                  {
                    value: 'CHILD', label: '어린이제품', pendingLabel: '처리 중…',
                    className: 'border border-measure bg-measure px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-85',
                  },
                  {
                    value: 'NOT_CHILD', label: '아님', pendingLabel: '처리 중…',
                    className: 'border border-rule px-3 py-1.5 text-[12px] text-ink-2 hover:bg-measure-soft',
                  },
                  {
                    value: 'UNKNOWN', label: '알 수 없음', pendingLabel: '처리 중…',
                    className: 'border border-rule px-3 py-1.5 text-[12px] text-ink-2 hover:bg-measure-soft',
                  },
                  ...(ev.child_product_check !== 'UNCHECKED' ? [{
                    value: 'UNCHECKED', label: '확인 취소', pendingLabel: '처리 중…',
                    className: 'px-2 py-1.5 text-[11px] text-ink-3 underline underline-offset-2 hover:text-measure',
                  }] : []),
                ]}
              >
                <input
                  name="note"
                  defaultValue={ev.child_product_note ?? ''}
                  placeholder="무엇을 보고 정했는지 — 예: 포장에 '3세 이상' 표시"
                  className="min-w-[16rem] flex-1 border border-rule bg-surface px-2 py-1.5 text-[12px]"
                />
              </ActionForm>
              </div>
            </div>
          </div>
        </div>
      </section>

      {children}
    </div>
  );
}
