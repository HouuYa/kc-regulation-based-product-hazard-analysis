/**
 * 병행 점검 화면 (070)
 *
 * 두 구역으로 나뉘고, 놓이는 자리가 다르다.
 *
 *   「보고서가 한 일」   사건 요약 바로 아래. 보고서가 무엇을 했는지 사실만
 *   「병행 점검 소견」   기본 조항 목록 **아래**. 위가 아니다.
 *
 * 왜 소견을 아래에 두는가
 *   위에 두면 기본 목록을 덮어쓰는 것처럼 읽힌다. 04-1 §8 이 실측으로 확인한
 *   것이 그 반대다 — 원인 다리를 기본 검색에 자동 반영했더니 재현율이
 *   16.2%→13.1% 로 떨어졌고, 결론은 "자동으로 켜지 말고 담당자 손에 쥐여 줘라"
 *   였다. 자리 자체가 그 결론을 말해야 한다.
 *
 * 불량과 불법을 눈으로도 가른다
 *   시험항목(TEST_ITEM)과 인증·표시 확인항목(CERT_MARKING_CHECK)은 테두리 색과
 *   머리말을 다르게 준다. 표 구조로만 갈라 두면 화면에서 섞여 보이고, 담당자는
 *   화면을 보고 시험을 의뢰한다.
 */

import { ActionForm } from '@/components/ActionForm';
import { ExternalLinkPreview } from '@/components/ExternalLinkPreview';
import { loadSecondOpinion, type SecondOpinionView, type FindingRow } from '@/lib/second-opinion/load';
import { runSecondOpinionAction, recordFindingReview } from './actions';

/** 라벨 하나 + 숫자 하나. 문장 대신 이 모양으로 늘어놓는다(개조식) */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-ink-3">{label}</span>
      <span className="addr tnum font-medium text-ink">{value}</span>
    </span>
  );
}

const ITEM_LABEL: Record<string, string> = {
  TEST_PERFORMED: '수행한 시험',
  IDENTITY_CHECK: '동일성 확인',
  CONCLUSION: '보고서 결론',
  NON_TARGET: '보고서 결론 (비대상)',
  MEASUREMENT: '측정값',
  MARKING_NOTE: '표시 관련',
};

/**
 * verdict 배지 앞에 "판정: "을 붙일지 — 결론 행에서만 붙인다.
 *
 * 수행한 시험 행은 "유해화학물질 분석 [적합]" 처럼 이름 바로 옆이라 그 자체로
 * "이 시험 결과가 적합"으로 읽힌다. 그런데 결론 행은 "보고서 결론 · 사고원인
 * 서술 없음 [부적합]" 처럼 옆에 또 다른 낱말(원인 서술 여부)이 있어서, 부적합이
 * 무엇을 가리키는지(시험 결과인지, 원인 서술 여부인지) 헷갈린다는 지적을 받았다.
 * "판정: " 을 붙여 이 verdict 가 보고서가 스스로 내린 결론(적합/부적합/원인미상/
 * 비대상/기타)이라는 것을 바로 옆에서 밝힌다.
 */
function verdictLabel(itemType: string, verdict: string): string {
  return itemType === 'CONCLUSION' || itemType === 'NON_TARGET' ? `판정: ${verdict}` : verdict;
}

/**
 * PHOTO 출처는 verified=false 라도 "찾지 못했다"고 말하지 않는다.
 *
 * span_verified 는 narrative 부분문자열 검사 결과인데, 사진에서 온 값은 애초에
 * 원문에 있을 수 없는 값이다(사진 안 숫자다). 그걸 "원문에서 다시 찾지 못했다"고
 * 적으면 마치 추출 실패처럼 보인다 — 라운드 72가 이 구분을 명확히 했다.
 */
function Quote({ span, verified, source }: { span: string; verified: boolean; source: string }) {
  const label =
    source === 'PHOTO' ? '사진에서 관찰'
      : verified ? '원문 인용'
      : '원문 인용 · 원문에서 다시 찾지 못했습니다';

  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[11px] text-ink-3">{label}</summary>
      <blockquote
        className={`mt-1 border-l-2 pl-2 text-[12px] leading-relaxed ${
          source === 'PHOTO' ? 'border-measure text-ink-2'
            : verified ? 'border-rule text-ink-2' : 'border-amber-400 text-ink-3'
        }`}
      >
        {span}
      </blockquote>
    </details>
  );
}

/** 구역 1 — 보고서가 한 일 */
export async function InvestigationSummary({ caseId }: { caseId: number }) {
  const view = await loadSecondOpinion(caseId);

  return (
    <section id="analysis-investigation" className="mt-4 scroll-mt-8 border-t border-rule pt-5">
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <span className="label">보고서 기재 내용 분석</span>
        <div className="text-[13px] leading-relaxed">
          {!view ? (
            <>
              <p className="text-ink-2">아직 병행 점검을 하지 않았습니다.</p>
              <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-ink-3">
                원문에서 수행 시험·결론 추출 → 적용 안전기준 전체와 대조 → 시험하지 않은
                구간 도출. (사고조사보고서 71건 중 70건이 수행 시험을 스스로 기재)
              </p>
              <div className="mt-3">
                <ActionForm
                  action={runSecondOpinionAction}
                  hidden={{ caseId }}
                  label="병행 점검 실행"
                  pendingLabel="점검하는 중…"
                  className="border border-rule px-3 py-1.5 text-[12px] hover:bg-paper-2"
                  messageClassName="text-[12px] leading-relaxed text-ink-2"
                />
              </div>
            </>
          ) : (
            <>
              <ul className="space-y-2">
                {view.items.map((it, i) => (
                  <li key={i} className="border-b border-rule/50 pb-2 last:border-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="addr text-[11px] text-ink-3">
                        {ITEM_LABEL[it.itemType] ?? it.itemType}
                      </span>
                      <span className="font-medium">{it.label}</span>
                      {it.verdict && (
                        <span className="addr border border-rule px-1.5 py-0.5 text-[11px] text-ink-2">
                          {verdictLabel(it.itemType, it.verdict)}
                        </span>
                      )}
                      {it.valueNum != null && (
                        <span className="addr text-[12px] text-ink-2">
                          {it.valueNum}{it.unit ?? ''}
                        </span>
                      )}
                    </div>
                    <Quote span={it.evidenceSpan} verified={it.spanVerified} source={it.extractSource} />
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                <Stat label="적용 기준" value={`${view.standardCount}종`} />
                <Stat
                  label="성능요건"
                  value={`${view.requirementSectionCount}개 절 (${view.requirementClauseCount}개 조항)`}
                />
                <Stat label="시험" value={`${view.performedTestCount}건`} />
                {view.unmappedTestCount > 0 && (
                  <Stat label="미매칭" value={`${view.unmappedTestCount}건`} />
                )}
              </div>
              {view.unmappedTestCount > 0 && (
                <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                  미매칭 — 시험을 안 한 게 아니라 기준 조항 제목에 못 맞춘 것. 공백 목록 제외.
                </p>
              )}

              <div className="addr mt-2 text-[11px] text-ink-3">
                {view.startedAt.slice(0, 16)} · {view.extractModel}
                {view.extractAgreement != null && ` · 반복 일치도 ${view.extractAgreement.toFixed(2)}`}
                {view.droppedSpanCount > 0 && ` · 인용을 대지 못해 버린 항목 ${view.droppedSpanCount}건`}
              </div>

              <div className="mt-3">
                <ActionForm
                  action={runSecondOpinionAction}
                  hidden={{ caseId }}
                  label="다시 점검"
                  pendingLabel="점검하는 중…"
                  className="border border-rule px-3 py-1.5 text-[12px] hover:bg-paper-2"
                  messageClassName="text-[12px] leading-relaxed text-ink-2"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * 판정 버튼 문구·생김새 (2026-09-14, 담당자 지적)
 *
 * "확인해 볼 만함/보류/해당 없음 버튼은 클릭하는 것이죠? 클릭을 하라는
 * 것인지 잘 드러나지 않습니다" — 전에는 폭 좁은 옅은 회색 테두리(px-2
 * py-0.5, text-[11px])라 이 화면의 다른 결정 버튼(채택/반려 등, px-3
 * py-1.5)보다 훨씬 작고 수수해서 눌러야 하는 자리로 안 보였다. 크기를
 * 다른 결정 버튼과 맞추고, 셋을 서로 다른 색으로 갈라 지금 어떤 판정이
 * 가능한지 한눈에 들어오게 했다.
 *
 * "확인해 볼 만함"이란 낱말도 어감이 이상하다는 지적을 받아 "확인 필요"로
 * 줄였다 — actions.ts 의 완료 문구("판정했습니다 — …")도 같이 맞춘다.
 */
const FINDING_DECISION_BUTTON_LABEL: Record<'ACCEPTED' | 'HOLD' | 'REJECTED', string> = {
  ACCEPTED: '확인 필요', HOLD: '보류', REJECTED: '해당 없음',
};

const FINDING_DECISION_BUTTON_CLASS: Record<'ACCEPTED' | 'HOLD' | 'REJECTED', string> = {
  ACCEPTED: 'border border-measure px-3 py-1.5 text-[12px] font-medium text-measure hover:bg-measure-soft',
  HOLD: 'border border-caution px-3 py-1.5 text-[12px] font-medium text-caution hover:bg-caution-soft',
  REJECTED: 'border border-rule px-3 py-1.5 text-[12px] text-ink-2 hover:bg-rule-soft',
};

function ReviewButtons({ finding, caseId }: { finding: FindingRow; caseId: number }) {
  if (finding.decision) {
    return (
      <span className="addr text-[11px] text-ink-3">
        판정함 · {FINDING_DECISION_BUTTON_LABEL[finding.decision as 'ACCEPTED' | 'HOLD' | 'REJECTED'] ?? finding.decision}
      </span>
    );
  }
  return (
    <ActionForm
      action={recordFindingReview}
      hidden={{ findingId: finding.id, caseId }}
      buttonField="decision"
      buttons={(['ACCEPTED', 'HOLD', 'REJECTED'] as const).map((d) => ({
        value: d,
        label: FINDING_DECISION_BUTTON_LABEL[d],
        pendingLabel: '처리 중…',
        className: FINDING_DECISION_BUTTON_CLASS[d],
      }))}
    />
  );
}

/**
 * 관련 리콜 한 건
 *
 * 리콜 개요(표+사진)를 목록에 항상 펼쳐 두면 여덟 건이면 카드도 여덟 개가
 * 늘어서 화면이 길어진다(2026-09-14, 담당자 지적 — 스크린샷으로 그 카드를
 * 짚으며 "보일 필요가 없다"). "관련 리콜" 자리를 누르면 같은 개요를 화면 안
 * 창(모달, 아래 ExternalLinkPreview)으로 볼 수 있으므로, 목록에는 한 줄
 * 참조만 남기고 개요는 누를 때만 보여준다.
 */
function FindingItem({
  f, caseId, border,
}: { f: FindingRow; caseId: number; border: string }) {
  return (
    <li className={`border-l-2 ${border} pl-3`}>
      <div className="text-[13px] leading-relaxed">
        {f.sectionMarker && (
          <span className="addr mr-2 text-[12px] text-ink-2">
            {f.standardName} 절 {f.sectionMarker}
            {f.part ? ` [${f.part}]` : ''}
            {f.sectionTitle ? ` 「${f.sectionTitle}」` : ''}
          </span>
        )}
        {f.refCaseId && (
          /*
            화면 안 창(모달)으로 연다 (2026-09-14, 담당자 지적: "2 리콜 메뉴의
            원본보기처럼 창을 내부에 띄워서 병행으로 보면서 검토")

            처음엔 새 탭으로 열었는데, 담당자가 원한 것은 "새 탭"이 아니라
            "지금 화면을 떠나지 않고 같이 보는 것"이었다. 리콜 원문 보기와
            같은 컴포넌트(ExternalLinkPreview)를 그대로 쓴다 — 다만 대상이
            우리 서버의 페이지라 iframe 삽입이 막힐 일이 없으므로
            `internal`로 그 안내 문구만 뺀다.
          */
          <ExternalLinkPreview
            href={`/analysis/${f.refCaseId}`}
            label={f.refTitle ?? `사건 ${f.refCaseId}`}
            internal
            className="addr mr-2 text-[12px] text-measure underline underline-offset-2 hover:opacity-80"
          />
        )}
        {f.hfCode && !f.sectionMarker && !f.refCaseId && (
          <span className="addr mr-2 text-[12px] text-ink-2">{f.hfCode}</span>
        )}
        {f.refCaseId && (f.hfCode || f.dtCode) && (
          <span className="addr mr-2 text-[11px] text-ink-3">
            {f.dtCode && `DT ${f.dtCode}`}
            {f.dtCode && f.hfCode && ' · '}
            {f.hfCode && `HF ${f.hfCode}`}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{f.rationale}</p>
      {f.testMethodMarker && (
        <p className="mt-0.5 text-[12px] text-ink-2">
          이 요건을 확인하는 시험방법 조항: {f.testMethodMarker}
        </p>
      )}
      <div className="mt-1.5">
        <ReviewButtons finding={f} caseId={caseId} />
      </div>
    </li>
  );
}

function FindingList({
  findings, caseId, tone,
}: { findings: FindingRow[]; caseId: number; tone: 'test' | 'legal' | 'ref' }) {
  const border =
    tone === 'test' ? 'border-l-measure' : tone === 'legal' ? 'border-l-caution' : 'border-l-rule';

  return (
    <ul className="mt-2 space-y-2">
      {findings.map((f) => (
        <FindingItem key={f.id} f={f} caseId={caseId} border={border} />
      ))}
    </ul>
  );
}

/** 구역 2 — 병행 점검 소견. 기본 조항 목록 아래에 놓인다 */
export async function SecondOpinionFindings({ caseId }: { caseId: number }) {
  const view: SecondOpinionView | null = await loadSecondOpinion(caseId);
  if (!view) return null;

  const gap = view.findings.filter((f) => f.findingType === 'TEST_GAP');
  const legal = view.findings.filter((f) => f.outputKind === 'CERT_MARKING_CHECK');
  const policy = view.findings.filter((f) => f.outputKind === 'POLICY_SIGNAL');
  const stat = view.findings.filter((f) => f.findingType === 'RECALL_EVIDENCE' && !f.refCaseId);
  /*
    같은 리콜 사건을 가리키는 소견이 여러 번 쌓여 있을 수 있다 (2026-09-14 실물
    확인) — "다시 점검"을 반복하면 옛 소견을 지우지 않고 새로 더하기만 해서,
    사건 하나에 refCaseId 가 같은 행이 6개까지 쌓인 사례를 봤다(사건 4639,
    닮은 리콜 8건이 각각 6번씩 = 48행). 그 자체는 이번에 고칠 자리가 아니지만
    (다시 점검의 누적 정책은 별도 판단이 필요하다), 같은 리콜을 가리키는 "확인해
    볼 만함/보류/해당 없음" 판정 버튼이 여섯 벌씩 늘어서면 담당자가 어느 것을
    이미 판정했는지도 헷갈리므로, 화면에 표시할 목록만 refCaseId 로 한 건씩
    추린다 — 저장된 행 자체는 그대로 둔다.
  */
  const casesByRef = new Map<number, FindingRow>();
  for (const f of view.findings) {
    if (f.findingType === 'RECALL_EVIDENCE' && f.refCaseId && !casesByRef.has(f.refCaseId)) {
      casesByRef.set(f.refCaseId, f);
    }
  }
  const cases = [...casesByRef.values()];

  return (
    <section id="analysis-second-opinion" className="mt-10 scroll-mt-8 border-t border-rule pt-6">
      <h2 className="text-[15px] font-semibold">
        병행 점검 소견
        <span className="ml-2 text-[12px] font-normal text-ink-3">
          미판정 {view.findings.filter((f) => !f.decision).length}건
        </span>
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
        위 기본 목록(피해유형 기준 조항)과는 다른 두 번째 참고 자료 — 시험 공백 ·
        인증·표시 · 리콜 사례. 전부 미확정, 판단은 담당자.
      </p>

      <div className="mt-5 space-y-6">
        <div id="analysis-second-opinion-gap" className="scroll-mt-8">
          <h3 className="text-[13px] font-semibold">
            시험 범위 공백 {gap.length}건 — 시험항목 후보
          </h3>
          <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            <Stat label="시험" value={`${view.performedTestCount}건`} />
            <Stat label="성능요건" value={`${view.requirementSectionCount}개 절`} />
            <Stat label="공백 후보" value={`${gap.length}개`} />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
            전부 시험하라는 뜻 아님 — 이 사고와 닿는 정도가 높은 순으로만 추림.
          </p>
          {gap.length === 0 ? (
            <p className="mt-2 text-[12px] text-ink-3">
              {view.standardCount === 0
                ? '적용할 안전기준을 정하지 못해 공백을 낼 수 없었습니다. 품목을 먼저 확정해야 합니다.'
                : '이 사고와 닿으면서 시험하지 않은 절을 찾지 못했습니다.'}
            </p>
          ) : (
            <FindingList findings={gap} caseId={caseId} tone="test" />
          )}
        </div>

        {legal.length > 0 && (
          <div>
            <h3 className="text-[13px] font-semibold">
              인증·표시 확인항목 {legal.length}건
            </h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
              시험 항목 아님 — 법령 확인 사항. 시험의뢰 목록 제외.
            </p>
            <FindingList findings={legal} caseId={caseId} tone="legal" />
          </div>
        )}

        {/*
          기준 사각지대는 접어 둔다 (05_02 P2-2) — 사고조사 담당자가 판정할 몫이 아니라
          KC기준·정책 담당이 볼 신호다. 그쪽 화면(정책 현황판)에 모아 보여 준다.
        */}
        {policy.length > 0 && (
          <details>
            <summary className="cursor-pointer text-[13px] font-semibold">
              기준 사각지대 {policy.length}건
              <span className="ml-2 text-[11px] font-normal text-ink-3">KC기준·정책 담당이 보는 신호 — 펼쳐 보기</span>
            </summary>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
              시험·인증 위반 아님 — 기준 체계 빈틈 신호. 전문가 확인 전 정책자료 미사용.
            </p>
            <FindingList findings={policy} caseId={caseId} tone="ref" />
          </details>
        )}

        <div id="analysis-second-opinion-recall" className="scroll-mt-8">
          <h3 className="text-[13px] font-semibold">
            리콜 정보와 교차 분석 {stat.length + cases.length}건
          </h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
            국내·해외 리콜 자료와 견준 참고 정보 — 유사 사례와 위해 원인 두 갈래.
            원인 확정 아님, 판단은 담당자.
          </p>

          <div className="mt-3">
            <h4 className="text-[12px] font-semibold text-ink-2">유사 사례 {cases.length}건</h4>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
              품목·GPC 분류가 닮은 리콜 — 실제로 일어난 적이 있음을 보임.
            </p>
            {cases.length > 0 ? (
              <FindingList findings={cases} caseId={caseId} tone="ref" />
            ) : (
              <p className="mt-1 text-[12px] text-ink-3">닮은 리콜 사례를 찾지 못했습니다.</p>
            )}
          </div>

          <div className="mt-4">
            <h4 className="text-[12px] font-semibold text-ink-2">위해 원인 {stat.length}건</h4>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
              같은 피해유형에 해외 리콜에서 흔히 같이 붙는 원인 — 방향만 제시, 이 사고의
              원인이라는 뜻 아님.
            </p>
            {stat.length > 0 ? (
              <>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                  {stat[0]?.sampleSize != null && (
                    <Stat label="비교 표본" value={`해외 리콜 ${stat[0].sampleSize}건`} />
                  )}
                  <Stat label="원인 후보" value={`${stat.length}개`} />
                </div>
                <FindingList findings={stat} caseId={caseId} tone="ref" />
              </>
            ) : (
              <p className="mt-1 text-[12px] text-ink-3">
                {view.scopeEvidence ?? '통계 근거를 찾지 못했습니다.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
