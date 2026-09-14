import Link from 'next/link';
import { FlowChart } from '@/components/Panel';
import { ActionForm } from '@/components/ActionForm';
import { ScreenSwitch } from '@/components/ScreenSwitch';
import { RecallOverview } from '@/components/RecallOverview';
import { StageAnnouncer } from '@/components/StageContext';
import { standardName } from '@/lib/standards/label';
import { loadRecallOverview } from '@/lib/recall/overview';
import { load } from './data';
import { setChildProductCheck } from './actions';

/**
 * 사건 분석 — 공통 헤더 (2026-09-14, 와이어프레임 1a)
 *
 * 검토(`page.tsx`)·인사이트(`insight/page.tsx`) 두 화면이 함께 쓰는 부분을
 * 여기 한 번만 그린다 — 사건 요약, 품목·적용기준(어린이제품 확정 버튼 포함),
 * 그리고 두 화면을 오가는 링크. 설계 근거는
 * docs/화면_구조_개편_검토_인사이트_분리_2026-09-12.md §3.1 (탭 밖 공통 헤더).
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
        <Link href="/cases" className="mt-2 inline-block text-[13px] text-measure underline">
          사건 목록으로
        </Link>
      </div>
    );
  }

  const { ev, tags, run, results, standards, photos } = data;

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
            { label: '산출물', href: '/insights', note: '시험항목·개선요인', state: 'todo' },
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
        검토/인사이트 화면 전환 — 탭이 아니라 페이지 링크(1a). 자세한 설계 근거는
        docs/화면_구조_개편_검토_인사이트_분리_2026-09-12.md.
      */}
      <ScreenSwitch
        options={[
          { href: `/analysis/${caseId}`, label: '검토 화면' },
          { href: `/analysis/${caseId}/insight`, label: '인사이트 화면' },
        ]}
      />

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
                <strong className="font-semibold">품목 미확정 (SCOPE_UNRESOLVED)</strong>
                <p className="mt-1">
                  적용 기준 미확정 — 분석 미실행 (전 품목 검색 시 다른 제품 시험 혼입).
                  품목 등록 후 재실행.
                </p>
              </div>
            )}

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
