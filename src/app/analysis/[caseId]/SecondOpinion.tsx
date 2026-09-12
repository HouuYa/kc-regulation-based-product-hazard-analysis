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
import { loadSecondOpinion, type SecondOpinionView, type FindingRow } from '@/lib/second-opinion/load';
import { runSecondOpinionAction, recordFindingReview } from './actions';

const ITEM_LABEL: Record<string, string> = {
  TEST_PERFORMED: '수행한 시험',
  IDENTITY_CHECK: '동일성 확인',
  CONCLUSION: '결론',
  NON_TARGET: '결론 (비대상)',
  MEASUREMENT: '측정값',
  MARKING_NOTE: '표시 관련',
};

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
        <span className="label">보고서가 한 일</span>
        <div className="text-[13px] leading-relaxed">
          {!view ? (
            <>
              <p className="text-ink-2">아직 병행 점검을 하지 않았습니다.</p>
              <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-ink-3">
                보고서가 어떤 시험을 했고 무엇이라고 결론 내렸는지를 원문에서 뽑아,
                이 품목에 적용되는 안전기준 전체와 견줍니다. 사고조사보고서는 수행한
                시험을 스스로 적어 두므로(71건 중 70건), 그 목록과 기준을 견주면
                「시험하지 않은 구간」이 나옵니다.
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
                          {it.verdict}
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

              <p className="mt-3 text-[12px] leading-relaxed text-ink-2">
                이 품목에 적용되는 안전기준은 {view.standardCount}종이고 성능요건은{' '}
                {view.requirementSectionCount}개 절({view.requirementClauseCount}개 조항)입니다.
                보고서가 시험한 것은 {view.performedTestCount}건입니다.
                {view.unmappedTestCount > 0 && (
                  <>
                    {' '}그중 {view.unmappedTestCount}건은 기준의 조항 제목에 맞추지 못했습니다 —
                    <strong className="font-medium"> 시험을 안 한 것이 아니라 우리가 못 맞힌 것</strong>이므로
                    아래 공백 목록에 넣지 않았습니다.
                  </>
                )}
              </p>

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
    tone === 'test' ? 'border-l-measure' : tone === 'legal' ? 'border-l-amber-500' : 'border-l-rule';

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
              <span className="addr mr-2 text-[12px] text-ink-2">
                {f.refTitle ?? `사건 ${f.refCaseId}`}
              </span>
            )}
            {f.hfCode && !f.sectionMarker && !f.refCaseId && (
              <span className="addr mr-2 text-[12px] text-ink-2">{f.hfCode}</span>
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
      <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-ink-3">
        위 목록은 이 사고의 <strong className="font-medium">피해유형</strong>으로 찾은 조항입니다.
        아래는 보고서가 <strong className="font-medium">시험하지 않은 구간</strong>과 국내·해외
        리콜에서 온 참고 자료입니다. 위 목록을 대신하지 않습니다 — 성격이 다른 두 번째 목록입니다.
        어느 것도 확정이 아니며, 판단은 품목을 아는 담당자가 합니다.
      </p>

      <div className="mt-5 space-y-6">
        <div>
          <h3 className="text-[13px] font-semibold">
            시험 범위 공백 {gap.length}건 — 시험항목 후보
          </h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
            보고서는 {view.performedTestCount}건을 시험했고, 이 품목의 성능요건은{' '}
            {view.requirementSectionCount}개 절입니다. 그중 이 사고와 닿는데 시험하지 않은 것입니다.
            <strong className="font-medium"> 「전부 시험하라」는 뜻이 아닙니다</strong> — 닿는 정도가
            높은 순으로 {gap.length}개만 추렸습니다.
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
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
              <strong className="font-medium">시험으로 확인하는 것이 아닙니다.</strong>{' '}
              법령이 정한 의무를 지켰는지는 법령을 보면 판정됩니다. 시험의뢰 목록에 넣지 마십시오.
            </p>
            <FindingList findings={legal} caseId={caseId} tone="legal" />
          </div>
        )}

        {policy.length > 0 && (
          <div>
            <h3 className="text-[13px] font-semibold">기준 사각지대 {policy.length}건</h3>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
              시험도 인증 위반도 아니라 <strong className="font-medium">기준 체계 자체의 빈틈</strong>일
              수 있다는 신호입니다. 전문가가 확인하기 전에는 정책 판단 자료로 쓰지 않습니다.
            </p>
            <FindingList findings={policy} caseId={caseId} tone="ref" />
          </div>
        )}

        <div>
          <h3 className="text-[13px] font-semibold">리콜 교차 근거 {stat.length + cases.length}건</h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
            {view.scopeEvidence ?? '국내·해외 리콜에서 이 피해유형에 실제로 따라온 원인과 닮은 사례입니다.'}
            {' '}통계는 방향을 주고 사례는 그 방향이 실제로 일어난 적이 있음을 보입니다.
            어느 쪽도 이 사고의 원인이라는 뜻은 아닙니다.
          </p>
          {stat.length > 0 && <FindingList findings={stat} caseId={caseId} tone="ref" />}
          {cases.length > 0 && <FindingList findings={cases} caseId={caseId} tone="ref" />}
          {stat.length + cases.length === 0 && (
            <p className="mt-2 text-[12px] text-ink-3">닮은 리콜이나 통계 근거를 찾지 못했습니다.</p>
          )}
        </div>
      </div>
    </section>
  );
}
