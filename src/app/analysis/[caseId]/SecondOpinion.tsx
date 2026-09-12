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

import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
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

function ReviewButtons({ finding, caseId }: { finding: FindingRow; caseId: number }) {
  if (finding.decision) {
    return (
      <span className="addr text-[11px] text-ink-3">
        판정함 · {finding.decision === 'ACCEPTED' ? '확인해 볼 만함'
          : finding.decision === 'HOLD' ? '보류' : '해당 없음'}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {(['ACCEPTED', 'HOLD', 'REJECTED'] as const).map((d) => (
        <form key={d} action={recordFindingReview}>
          <input type="hidden" name="findingId" value={finding.id} />
          <input type="hidden" name="caseId" value={caseId} />
          <input type="hidden" name="decision" value={d} />
          <button
            type="submit"
            className="border border-rule px-2 py-0.5 text-[11px] text-ink-2 hover:bg-paper-2"
          >
            {d === 'ACCEPTED' ? '확인해 볼 만함' : d === 'HOLD' ? '보류' : '해당 없음'}
          </button>
        </form>
      ))}
    </div>
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
        <li key={f.id} className={`border-l-2 ${border} pl-3`}>
          <div className="text-[13px] leading-relaxed">
            {f.sectionMarker && (
              <span className="addr mr-2 text-[12px] text-ink-2">
                {f.standardName} 절 {f.sectionMarker}
                {f.part ? ` [${f.part}]` : ''}
                {f.sectionTitle ? ` 「${f.sectionTitle}」` : ''}
              </span>
            )}
            {f.refCaseId && (
              <Link
                href={`/analysis/${f.refCaseId}`}
                className="addr mr-2 text-[12px] text-measure underline underline-offset-2 hover:opacity-80"
              >
                {f.refTitle ?? `사건 ${f.refCaseId}`}
              </Link>
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
      ))}
    </ul>
  );
}

const QUEUE_LABEL: Record<string, string> = {
  TEST_GAP: '시험 공백',
  LEGAL_SIGNAL: '인증·표시',
  STANDARD_GAP: '기준 사각지대',
};

/** RECALL_EVIDENCE 는 유사 사례·위해 원인 둘로 갈리므로 따로 판정한다(074) */
function queueLabel(f: FindingRow): string {
  if (f.findingType === 'RECALL_EVIDENCE') return f.refCaseId ? '유사 사례' : '위해 원인';
  return QUEUE_LABEL[f.findingType] ?? f.findingType;
}

/**
 * 구역 3 — 병행 점검 미판정 큐. 검토 탭 전용(073).
 *
 * SecondOpinionFindings 와 같은 데이터를 다르게 그린다 — rationale 긴 설명을
 * 빼고 라벨 한 줄 + 판정 버튼만 남겨, 빠르게 훑어 판정하는 용도다. 자세한
 * 근거는 인사이트 탭의 SecondOpinionFindings 에서 읽는다.
 */
export async function SecondOpinionReviewQueue({ caseId }: { caseId: number }) {
  const view = await loadSecondOpinion(caseId);
  if (!view) return null;
  const pending = view.findings.filter((f) => !f.decision);
  if (pending.length === 0) return null;

  return (
    <section id="analysis-second-opinion-queue" className="mt-10 scroll-mt-8 border-t border-rule pt-6">
      <h2 className="text-[15px] font-semibold">병행 점검 미판정 {pending.length}건</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
        시험 공백·인증표시·리콜 정보 등 병행 점검 후보 중 아직 판정하지 않은 것.
        자세한 근거는 인사이트 탭에서.
      </p>
      <ul className="mt-3 space-y-1.5">
        {pending.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-2 border-b border-rule/50 py-2">
            <span className="addr shrink-0 text-[11px] text-ink-3">
              {queueLabel(f)}
            </span>
            <span className="text-[12px] font-medium">
              {f.sectionMarker
                ? `${f.standardName ?? ''} 절 ${f.sectionMarker}`
                : f.refTitle ?? (f.refCaseId ? `사건 ${f.refCaseId}` : f.hfCode ?? '')}
            </span>
            <div className="ml-auto">
              <ReviewButtons finding={f} caseId={caseId} />
            </div>
          </li>
        ))}
      </ul>
    </section>
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
  const cases = view.findings.filter((f) => f.findingType === 'RECALL_EVIDENCE' && f.refCaseId);

  return (
    <section id="analysis-second-opinion" className="mt-10 scroll-mt-8 border-t border-rule pt-6">
      <h2 className="text-[15px] font-semibold">병행 점검 소견</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
        위 기본 목록(피해유형 기준 조항)과는 다른 두 번째 참고 자료 — 시험 공백 ·
        인증·표시 · 리콜 사례. 전부 미확정, 판단은 담당자.
      </p>

      <div className="mt-5 space-y-6">
        <div>
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

        {policy.length > 0 && (
          <div>
            <h3 className="text-[13px] font-semibold">기준 사각지대 {policy.length}건</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
              시험·인증 위반 아님 — 기준 체계 빈틈 신호. 전문가 확인 전 정책자료 미사용.
            </p>
            <FindingList findings={policy} caseId={caseId} tone="ref" />
          </div>
        )}

        <div>
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
