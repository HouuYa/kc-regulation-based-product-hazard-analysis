/**
 * 기준 사각지대 (④) — 시험도 인증위반도 아니라 기준 자체가 못 잡는 자리
 *
 * 두 가지만 다룬다. 둘 다 "우리가 놓친 것"이 아니라 "기준 체계 자체의 빈틈"
 * 이라는 점에서 ①②와 다르다 — 그래서 output_kind 를 POLICY_SIGNAL 로 따로 둔다.
 *
 *   (비대상)     이 사고 유형에 적용할 안전기준 자체가 없다고 보고서가 적음
 *   문턱값 공백  시험은 적합인데 실제 피해가 발생 — 기준의 합격 기준값이
 *               이 위해를 못 잡는다는 신호
 *
 * emptyReason 과 섞지 않는다 (v0.7 §7.8)
 *   SCOPE_UNRESOLVED·TAGGING_INCOMPLETE 는 "우리 쪽 자료가 아직 안 갖춰졌다"는
 *   뜻이고, 여기서 다루는 것은 "자료는 다 갖춰졌는데 기준 자체가 이 위해를
 *   설계 목적으로 다루지 않는다"는 뜻이다. 성격이 다르다.
 *
 * 문턱값 실제 대조(허용치 vs 측정값)는 2단계 다음 몫이다
 *   여기서는 "적합인데 피해가 있다"는 사실만 표시하고, test_condition.allowance_raw
 *   와 실측값을 수치로 견주는 것은 하지 않는다 — 단위 환산·조건 매칭이 얽혀
 *   있어 섣불리 계산하면 틀린 숫자를 낸다. 지금은 "확인해 볼 만한 자리"까지만
 *   말하고, 판단은 담당자가 한다.
 */

/** 신체 피해가 없다고 보는 DT 코드. 이 셋만 빼고는 전부 실제 위해로 본다 */
const NO_INJURY_DT = new Set(['DT.OTHER.NEARMI', 'DT.NON-PHYS.PROP', 'DT.NON-PHYS.ECON']);

export interface Blindspot {
  kind: 'NON_TARGET' | 'THRESHOLD_GAP';
  rationale: string;
  evidenceSpan: string;
}

export interface BlindspotInput {
  conclusionVerdict: string;
  isNonTarget: boolean;
  conclusionEvidence: string;
  caseDtCodes: string[];
  measurements: Array<{ label: string; value: string; unit: string }>;
}

export function deriveBlindspots(input: BlindspotInput): Blindspot[] {
  const out: Blindspot[] = [];

  if (input.isNonTarget) {
    out.push({
      kind: 'NON_TARGET',
      rationale:
        '보고서가 "적용할 안전기준이 없다(비대상)"고 적었습니다. 이 사고 유형에 ' +
        '기준이 필요한지는 담당자가 정책적으로 판단할 사안입니다 — 이 시스템은 ' +
        '비대상 여부를 스스로 판정하지 않습니다.',
      evidenceSpan: input.conclusionEvidence,
    });
  }

  const hasRealInjury = input.caseDtCodes.some((c) => !NO_INJURY_DT.has(c));
  if (input.conclusionVerdict === '적합' && hasRealInjury && input.measurements.length > 0) {
    /*
      텍스트와 사진 측정값을 나눠서 보여 준다 (라운드 72 실측으로 잡은 결함).

      처음에는 그냥 앞의 3개를 잘라 썼다. 그런데 이 배열은 텍스트 측정값을
      먼저 넣고 사진(variant B) 측정값을 뒤에 붙이므로, 텍스트 측정값이 3개
      넘게 있으면 사진 재료는 저장은 되지만 소견 문구에는 한 번도 나오지
      않는다 — 8건 표본에서 실제로 이렇게 됐다(사진 측정값이 76건까지 쌓인
      사건도 있었는데 소견 문구엔 하나도 안 잡혔다). 사진 재료가 실제로
      소견을 바꾸는지 보려는 것이 이 통합의 목적이므로, 있으면 반드시
      보이게 한다.
    */
    const isPhoto = (x: { label: string }) => x.label.startsWith('[사진]');
    const text = input.measurements.filter((x) => !isPhoto(x)).slice(0, 2);
    const photo = input.measurements.filter(isPhoto).slice(0, 2);
    const m = [...text, ...photo].map((x) => `${x.label} ${x.value}${x.unit}`).join(', ');
    out.push({
      kind: 'THRESHOLD_GAP',
      rationale:
        `보고서는 시험 결과 "적합"으로 결론 냈지만 이 사고에 실제 피해가 있었습니다. ` +
        `측정값: ${m}. 기준의 합격 문턱값이 이 위해를 못 잡을 가능성이 있습니다 — ` +
        `수치 대조는 하지 않았고, 확인해 볼 만한 자리라는 신호만 냅니다.`,
      evidenceSpan: input.conclusionEvidence,
    });
  }

  return out;
}
