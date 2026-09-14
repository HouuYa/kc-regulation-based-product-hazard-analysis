import { DoneBanner } from '@/components/Panel';
import { PageToc, type TocItem } from '@/components/PageToc';
import { ExternalLinkPreview } from '@/components/ExternalLinkPreview';
import type { GpcMatchLevel } from '@/lib/gpc/verify';
import { GPC_SOURCE_LABEL, GPC_SOURCE_NOTE, needsReview, type GpcSource } from '@/lib/gpc/provenance';
import { InvestigationSummary, SecondOpinionFindings } from '../SecondOpinion';
import { load, type CaseEventRow } from '../data';

export const dynamic = 'force-dynamic';

/**
 * 화면 D — 사건 분석 · 인사이트 (2026-09-14, 검토와 분리)
 *
 * 담당자가 "이 사건에 대해 더 알아보려고" 오는 화면. 전부 읽기 자료이고,
 * 병행 점검 판정 버튼만 예외적으로 그 자리에 같이 둔다(맥락을 읽으면서 바로
 * 판정해도 되도록) — 설계 근거는
 * docs/화면_구조_개편_검토_인사이트_분리_2026-09-12.md §3.3.
 *
 * 사건 요약·품목·적용기준 같은 공통 부분은 `../layout.tsx` 가 그린다.
 */

const GPC_LEVEL_LABEL: Record<Exclude<GpcMatchLevel, 'NONE'>, string> = {
  BRICK: 'Brick', CLASS: 'Class', FAMILY: 'Family', SEGMENT: 'Segment',
};

/*
  「병행 점검 소견」 하위 두 항목 (2026-09-14, 담당자 지적)

  이 구역 하나에 성격이 다른 하위 구역이 넷(시험 공백·인증표시·기준사각지대·
  리콜 교차분석)이라, 목차엔 상위 항목 하나뿐이라 스크롤 위치와 안 맞는다는
  지적을 받았다. 그중 늘 그려지는(조건부로 숨지 않는) 둘만 하위 항목으로
  추가한다 — 인증·표시·기준 사각지대는 해당 사건에 없으면 아예 안 그려져서,
  고정 목차에 넣으면 눌러도 아무 일이 안 일어나는 죽은 링크가 된다.
*/
const INSIGHT_TOC: TocItem[] = [
  { id: 'analysis-investigation', label: '보고서 기재 내용 분석' },
  { id: 'analysis-gpc', label: 'GPC 품목분류' },
  { id: 'analysis-recall', label: '해외 리콜 근거' },
  { id: 'analysis-second-opinion', label: '병행 점검 소견' },
  { id: 'analysis-second-opinion-gap', label: '시험 공백', indent: true },
  { id: 'analysis-second-opinion-recall', label: '관련 리콜', indent: true },
];

/** 사고보고서에만 붙는 구역 — 리콜은 원인이 이미 적혀 있어 병행 점검 대상이 아니다 */
const ACCIDENT_ONLY_IDS = new Set([
  'analysis-investigation', 'analysis-second-opinion',
  'analysis-second-opinion-gap', 'analysis-second-opinion-recall',
]);

/** gpc_verified_level 이 가리키는 계층의 코드·제목을 뽑는다 — 계층 아래는 항상 NULL 이다(verify.ts 참고) */
function gpcVerifiedCodeTitle(ev: CaseEventRow): { code: string; title: string | null } | null {
  switch (ev.gpc_verified_level) {
    case 'BRICK': return ev.gpc_verified_brick_code ? { code: ev.gpc_verified_brick_code, title: ev.gpc_verified_brick_title } : null;
    case 'CLASS': return ev.gpc_verified_class_code ? { code: ev.gpc_verified_class_code, title: ev.gpc_verified_class_title } : null;
    case 'FAMILY': return ev.gpc_verified_family_code ? { code: ev.gpc_verified_family_code, title: ev.gpc_verified_family_title } : null;
    case 'SEGMENT': return ev.gpc_verified_segment_code ? { code: ev.gpc_verified_segment_code, title: ev.gpc_verified_segment_title } : null;
    default: return null;
  }
}

export default async function AnalysisInsightPage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { caseId: raw } = await params;
  const { done } = await searchParams;
  const caseId = Number(raw);

  // layout.tsx 가 이미 caseId 를 검증하고 못 찾으면 여기까지 오지 않는다 —
  // cache() 로 감싼 load() 라 같은 요청 안에서는 DB 를 다시 안 부른다.
  const data = await load(caseId);
  if (!data) return null;

  const { ev, recall } = data;

  return (
    <>
      <DoneBanner message={done} />

      {ev.source_type === 'ACCIDENT' && <InvestigationSummary caseId={ev.id} />}

      {/* GPC(GS1 국제 품목분류) 후보 — 사고사진 비전 분석에서 뽑은 제품 서술로 조회한 것.
          라운드 12부터 standard 와 같은 방식(findAndVerifyGpc)으로 LLM 1차 검증을 거친다.
          검증됐어도 확정으로 단정하지 않는다 — 이 화면의 "판정하지 않는다" 원칙은 그대로다. */}
      {ev.gpc_candidates && ev.gpc_candidates.length > 0 && (() => {
        const verified = gpcVerifiedCodeTitle(ev);
        return (
          <section id="analysis-gpc" className="mt-4 scroll-mt-8 border-t border-rule pt-5">
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <span className="label">GPC 품목분류 후보</span>
              <div className="text-[13px] leading-relaxed">
                {/*
                  코드가 어디서 왔는지 먼저 밝힌다 (065, 담당자 지적)

                  "OECD 포털이 보내는 코드는 각 나라들이 등록할 때 사용하는 코드로
                  신빙성이 매우 높습니다." 등록국이 신고한 코드와 우리 AI 가 짐작한
                  코드를 같은 얼굴로 보여 주면 담당자가 무엇을 확인해야 하는지 알 수 없다.
                */}
                {ev.gpc_brick_code && ev.gpc_source && (
                  <div
                    className={`mb-3 border px-3 py-2 text-[12px] leading-relaxed ${
                      needsReview(ev.gpc_source)
                        ? 'border-rule-soft text-ink-2'
                        : 'border-measure bg-measure-soft text-ink-2'
                    }`}
                  >
                    <span className="addr text-ink">{ev.gpc_brick_code}</span>
                    <span className="ml-2 font-medium">
                      {GPC_SOURCE_LABEL[ev.gpc_source as GpcSource] ?? ev.gpc_source}
                    </span>
                    <p className="mt-1 text-ink-3">
                      {GPC_SOURCE_NOTE[ev.gpc_source as GpcSource] ?? ''}
                    </p>
                  </div>
                )}
                {ev.gpc_verified_level == null ? (
                  <p className="text-[12px] text-caution">
                    AI 검증 전 자료입니다(뜻이 비슷한 순서만 있음) — 순위 전체를 참고해 사람이
                    확인하세요.
                  </p>
                ) : ev.gpc_verified_level === 'NONE' ? (
                  <div className="border border-caution bg-caution-soft px-3 py-2 text-[12px] leading-relaxed text-caution">
                    <strong className="font-semibold">LLM 검증: 맞는 후보 없음</strong>
                    <p className="mt-1">확실히 일치하는 코드 없음 — 담당자 확인 필요.</p>
                    {ev.gpc_verification?.reasoning && (
                      <p className="mt-1 text-ink-2">{ev.gpc_verification.reasoning}</p>
                    )}
                  </div>
                ) : (
                  <div className="border border-measure bg-measure-soft/40 px-3 py-2 text-[12px] leading-relaxed">
                    <strong className="font-semibold text-measure">
                      LLM 검증({GPC_LEVEL_LABEL[ev.gpc_verified_level]})
                    </strong>{' '}
                    <span className="addr">{verified?.code}</span> {verified?.title}
                    {ev.gpc_verification && ` · 확신 ${ev.gpc_verification.confidenceScore}`}
                    {ev.gpc_verified_level !== 'BRICK' && (
                      <span className="ml-1 text-ink-3">
                        (정확한 Brick은 후보에 없어 상위 계층까지만 확인됨)
                      </span>
                    )}
                    {ev.gpc_verification?.reasoning && (
                      <p className="mt-1 text-ink-2">{ev.gpc_verification.reasoning}</p>
                    )}
                  </div>
                )}
                <p className="mt-2 text-[12px] text-ink-3">
                  아래 순위는 LLM이 1차 검증한 결과를 포함합니다. 최종 판단은 담당자가 합니다.
                </p>
                <ul className="mt-2 space-y-1">
                  {ev.gpc_candidates.map((c) => {
                    const isVerifiedBrick =
                      ev.gpc_verified_level === 'BRICK' && c.brickCode === ev.gpc_verified_brick_code;
                    const isEmbeddingTop1 = c.brickCode === ev.gpc_brick_code;
                    return (
                      <li
                        key={c.rank}
                        className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 py-1 text-[12px] ${
                          isVerifiedBrick
                            ? 'border border-measure text-measure'
                            : isEmbeddingTop1
                              ? 'border border-rule text-ink-2'
                              : 'text-ink-2'
                        }`}
                      >
                        <span className="addr tnum text-ink-3">{c.rank}위</span>
                        <span className="addr">{c.brickCode}</span>
                        <span className="font-medium">{c.brickTitle}</span>
                        {isVerifiedBrick && (
                          <span className="text-[10px] font-medium text-measure">검증 확정</span>
                        )}
                        {isEmbeddingTop1 && !isVerifiedBrick && (
                          <span className="text-[10px] text-ink-3">유사도 1위</span>
                        )}
                        <span className="text-ink-3">
                          {c.segmentTitle} &gt; {c.familyTitle} &gt; {c.classTitle}
                        </span>
                        <span className="addr tnum ml-auto text-ink-3">{c.similarity.toFixed(3)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </section>
        );
      })()}

      {/* 트랙 B — 해외 리콜에만 있는 것들 */}
      {recall && (
        <section id="analysis-recall" className="mt-4 scroll-mt-8 border-t border-rule pt-5">
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <span className="label">해외 리콜</span>
            <div className="text-[13px] leading-relaxed">
              <div className="addr text-[12px] text-ink-2">
                {recall.source} {recall.guid}
                {recall.recall_country && ` · ${recall.recall_country}`}
                {recall.detail_url && (
                  <>
                    {' · '}
                    <ExternalLinkPreview
                      href={recall.detail_url}
                      label="원문 보기"
                      className="text-measure underline underline-offset-2"
                    />
                  </>
                )}
              </div>
              {recall.hazard_type && <p className="mt-1">{recall.hazard_type}</p>}

              <div className="mt-3">
                <span className="label">리콜한 나라가 든 근거</span>
                {recall.cited_standards.length === 0 ? (
                  <p className="mt-1 text-[12px] text-ink-2">
                    공고에 어떤 표준을 위반했는지 적혀 있지 않습니다. 해외 리콜 열에 일곱은
                    이렇습니다. 그래서 우리 기준과 견줘 볼 수가 없습니다.
                  </p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {recall.cited_standards.map((s) => (
                      <span key={s} className="addr border border-rule px-1.5 py-0.5 text-[11px] text-ink-2">{s}</span>
                    ))}
                    <span className="text-[11px] text-ink-3">
                      {recall.matched_standard_ids.length > 0
                        ? `· 우리 기준 ${recall.matched_standard_ids.length}건과 번호가 같습니다`
                        : '· 우리 기준과 번호 매기는 방식이 달라 사람이 봐야 합니다'}
                    </span>
                  </div>
                )}
              </div>

              {/*
                미확인은 붉은 박스로 (2026-09-14, 담당자 요청) — 국내 유통 확인은
                제품안전기본법 13조 3항 보고의무 판단의 전제라, 확인이 안 된 채
                넘어가면 안 되는 항목이다. 다른 "담당자 확인 필요" 상태(어린이제품
                여부, layout.tsx)와 같은 색·문구 규칙을 쓴다.
              */}
              <div className={`mt-3 ${
                recall.domestic_check === 'UNCHECKED' ? 'border border-halt bg-halt-soft px-3 py-2' : ''
              }`}>
                <span className="label">국내에도 풀렸는가</span>
                <p className={`mt-1 text-[12px] leading-relaxed ${
                  recall.domestic_check === 'UNCHECKED' ? 'text-halt' : 'text-ink-2'
                }`}>
                  {recall.domestic_check === 'DISTRIBUTED' ? '국내에도 풀린 것으로 확인됐습니다.'
                    : recall.domestic_check === 'NOT_DISTRIBUTED' ? '국내에는 풀리지 않았습니다.'
                    : recall.domestic_check === 'UNKNOWN' ? '확인했지만 알아내지 못했습니다.'
                    : '미확인 — 담당자 확인 필요.'}
                  {' '}같은 제품이 국내에도 풀린 것으로 확인되면, 「제품안전기본법」 제13조
                  제3항에 따라 사업자가 곧바로 보고해야 하는지 따져 봐야 합니다.
                  이 시스템은 국내에 풀렸는지를 스스로 짐작하지 않습니다.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/*
        병행 점검 소견 (070) — 기본 조항 목록 **아래**에 둔다.

        위에 두면 기본 목록을 덮어쓰는 것처럼 읽힌다. 04-1 §8 의 실측이 그 반대를
        말한다 — 원인 다리를 기본 검색에 자동 반영했더니 재현율이 16.2%→13.1% 로
        떨어졌고, 결론은 "자동으로 켜지 말고 담당자 손에 쥐여 줘라" 였다.
      */}
      {ev.source_type === 'ACCIDENT' && <SecondOpinionFindings caseId={ev.id} />}

      <PageToc items={ev.source_type === 'ACCIDENT'
        ? INSIGHT_TOC
        : INSIGHT_TOC.filter((t) => !ACCIDENT_ONLY_IDS.has(t.id))} />
    </>
  );
}
