/**
 * 불법 신호 (②) — 인증·표시 확인항목
 *
 * 「동일성확인」이 무엇인지부터 다시 짚는다 (담당자 정정, 2026-09-12)
 *   보고서의 「동일성확인 결과」는 조사관의 의견이 아니다. 사고 제품이 KC 인증
 *   당시 모델과 같은지를 **인증기관에 질의해 받는 유권해석**이다. 그래서 이
 *   추출 값이 「상이함」이면, 그것은 우리 시스템이나 조사관이 "다른 것 같다"고
 *   짐작한 것이 아니라 인증기관이 이미 공식적으로 확정한 결과다.
 *   자세한 내용은 `docs/wiki/개념/법령제도/동일성확인_인증기관_유권해석.md`.
 *
 *   그래서 이 소견의 rationale 은 "AI가 추정함"이 아니라 "인증기관이 이미
 *   확정한 사실을 인용함"이라고 적는다. 다만 그 사실을 **어떤 법령 위반으로
 *   분류할지**(고의 위반인지 단순 검수 누락인지)는 여전히 담당자 판단이 필요해
 *   `needs_expert_confirm` 은 항상 true 로 둔다.
 *
 * 코드는 LLM 에게 묻지 않고 규칙으로 정한다 (04-1 §7, 라운드 69 제안)
 *   조사관이 위반이라 명시했으면 HF.M.REG.ILLEGAL, 고의성 서술이 없으면
 *   (또는 조사관이 스스로 "영향 없었을 것"이라 판단했으면) HF.S.QC. 표시
 *   누락은 HF.S.INFO. 셋 다 codebook.hf_route 가 LEGAL 인 것을 전제로 한다
 *   (004 정정으로 HF.S.QC 도 LEGAL 이 됐다).
 *
 * 왜 라운드 69의 18건이 아니라 병행 점검의 24건을 그대로 쓰는가
 *   라운드 70 이 24건 전수를 원문과 함께 사람이 읽어 오탐 0건을 확인했다.
 *   18건은 「동일성확인 결과」라는 어구에 고정된 정규식이 놓친 다른 표기
 *   (예: "(시험 결과) 최초 인증 당시 제품과 모델명이 상이함")까지 빠뜨린 값이었다.
 */

import { getDb } from '../db';

/** 조사관이 명시적으로 위반·고의를 언급했는지 판단하는 낱말들 */
const VIOLATION_WORDS = /위반|불법|고의|임의\s?변경|무단\s?변경|허위/;

/** 조사관이 스스로 "영향이 없다"고 판단한 문장 — HF.S.QC 쪽으로 무게를 싣는다 */
const NO_IMPACT_WORDS = /영향(을|이)?\s*(끼치지|주지|미치지)?\s*않았을|무관|해당(사고|화재)와\s*관련\s*없/;

export interface LegalSignal {
  hfCode: 'HF.M.REG.ILLEGAL' | 'HF.S.QC' | 'HF.S.INFO';
  route: string;
  differingParts: string;
  statedImpact: string;
  rationale: string;
  evidenceSpan: string;
}

interface IdentitySource {
  differingParts: string;
  statedImpact: string;
  evidenceSpan: string;
}

interface MarkingSource {
  note: string;
  evidenceSpan: string;
}

/** 동일성확인 상이함 → 위반 성격을 가른다 */
function classifyIdentity(s: IdentitySource): LegalSignal {
  const text = `${s.differingParts} ${s.statedImpact}`;
  const explicit = VIOLATION_WORDS.test(text);
  const ruledOutImpact = NO_IMPACT_WORDS.test(s.statedImpact);

  const hfCode = explicit && !ruledOutImpact ? 'HF.M.REG.ILLEGAL' : 'HF.S.QC';

  const rationale =
    `인증기관이 유권해석으로 확정한 사실입니다 — 인증 당시 모델과 사고 제품의 ` +
    `부품(${s.differingParts})이 다릅니다. ` +
    (s.statedImpact
      ? `조사관은 "${s.statedImpact}"라고 적었습니다. `
      : '') +
    `이 사실 자체는 확정이지만, 어떤 법령 위반으로 볼지는 담당자가 판단해야 ` +
    `합니다(${hfCode === 'HF.M.REG.ILLEGAL' ? '위반을 명시하는 표현이 있어 고의 위반 쪽으로' : '고의성을 단정할 서술이 없어 품질검수 쪽으로'} 1차 분류했습니다).`;

  return {
    hfCode,
    route: 'LEGAL',
    differingParts: s.differingParts,
    statedImpact: s.statedImpact,
    rationale,
    evidenceSpan: s.evidenceSpan,
  };
}

function classifyMarking(s: MarkingSource): LegalSignal {
  return {
    hfCode: 'HF.S.INFO',
    route: 'LEGAL',
    differingParts: '',
    statedImpact: '',
    rationale:
      `보고서에 표시 관련 서술이 있습니다 — "${s.note}". 표시 의무 위반은 시험이 ` +
      `아니라 법령을 보면 판정됩니다(CLAUDE.md §10). 실제 위반 여부는 담당자가 ` +
      `표시 규정과 대조해 확인해야 합니다.`,
    evidenceSpan: s.evidenceSpan,
  };
}

export function deriveLegalSignals(items: {
  identity: IdentitySource | null;
  markingNotes: MarkingSource[];
  /**
   * 사진(variant B)에서 식별한 내부 부품 구성 — 있으면 참고로 덧붙인다.
   *
   * 판정을 바꾸지는 않는다. 동일성확인(인증기관 유권해석)이 이미 확정한
   * 사실이고, 사진 관찰은 그 사실을 뒷받침하는 참고 자료일 뿐이다 — 라운드
   * 68~69 가 "사진 단서로 판정 자체를 바꾸는 것"은 효과가 없었다고 확인해
   * 둔 자리를 다시 반복하지 않는다.
   */
  photoComponents?: string[];
}): LegalSignal[] {
  const out: LegalSignal[] = [];
  if (items.identity) {
    const signal = classifyIdentity(items.identity);
    if (items.photoComponents?.length) {
      signal.rationale += ` (참고 — 사진에서 관찰된 부품: ${items.photoComponents.join(', ')})`;
    }
    out.push(signal);
  }
  for (const m of items.markingNotes) out.push(classifyMarking(m));
  return out;
}

/**
 * codebook.hf_route 에서 실제 route 를 읽어 온다.
 *
 * 규칙으로 LEGAL 이라 가정한 코드가 실제로도 LEGAL 인지 실행마다 확인한다 —
 * 코드북이 나중에 개정돼 route 가 바뀌면 이 계층도 조용히 따라가되, 만약
 * LEGAL 이 아니게 되면 그 자체가 데이터 점검 신호이므로 route 를 그대로
 * 저장해 드러낸다(가리지 않는다).
 */
export async function loadLegalRoutes(): Promise<Map<string, string>> {
  const rows = await getDb()<{ code: string; route: string }[]>`
    select code, route from codebook.hf_route
    where code in ('HF.M.REG.ILLEGAL', 'HF.S.QC', 'HF.S.INFO')
  `;
  return new Map(rows.map((r) => [r.code, r.route]));
}
