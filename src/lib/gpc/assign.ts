/**
 * GPC 조회 + 검증 오케스트레이션 — standard·case_event 공유 진입점 (라운드 12)
 *
 * findGpcCandidates()(조회)와 verifyGpcMatch()(검증)는 이미 범용이었지만,
 * "후보를 받아서, 없으면 NONE으로 처리하고, 있으면 검증한다"는 순서 자체가
 * tag-standards-gpc.ts 와 load-cases.ts 양쪽에 따로 짜여 있었다(load-cases.ts
 * 쪽은 검증 단계 자체가 아예 없었다 — 임베딩 1위를 검증 없이 확정). 담당자가
 * "사고조사 GPC 부여에도 같은 로직을 쓰냐"고 물어 아니라는 게 드러났고,
 * "최대한 공유"하도록 리팩터링해 달라고 해서 이 오케스트레이션을 여기로
 * 뽑았다(CLAUDE.md §9 — 여러 진입점이 같은 처리 로직을 쓸 때는 src/lib/에
 * 공유 함수로 뽑는다).
 *
 * verifyGpcMatch() 는 candidates 가 비어 있으면 호출할 수 없다(빈 배열로
 * enum 을 못 만든다). 호출부마다 "후보 없음" 분기를 따로 안 짜도 되게,
 * 여기서 합성된 NONE 결과를 대신 돌려준다 — 그래서 이 함수는 절대 null 을
 * 반환하지 않는다(verifyGpcMatch() 자체는 여전히 null 을 반환할 수 있는
 * 시그니처지만, 이 함수 안에서는 candidates.length > 0 일 때만 부르므로
 * 실제로 null 이 나올 수 없다).
 */

import { findGpcCandidates, DEFAULT_GPC_CANDIDATE_COUNT, type GpcCandidate } from './lookup';
import { verifyGpcMatch, type GpcVerification } from './verify';

export { DEFAULT_GPC_CANDIDATE_COUNT };

export interface GpcAssignment {
  candidates: GpcCandidate[];
  verification: GpcVerification;
}

const NO_CANDIDATES_VERIFICATION: GpcVerification = {
  level: 'NONE',
  segmentCode: null, segmentTitle: null,
  familyCode: null, familyTitle: null,
  classCode: null, classTitle: null,
  brickCode: null, brickTitle: null,
  confidenceScore: 0,
  reasoning: '후보 없음',
  model: '',
  candidateCount: 0,
};

/**
 * @param productName findGpcCandidates() 의 embedding 입력 중 상품명 자리(예: 품목명)
 * @param productContext findGpcCandidates() 의 embedding 입력이자 verifyGpcMatch() 의
 *   판단 근거로 그대로 쓰이는 서술 텍스트. 호출부마다 무엇을 조합해 넣을지는
 *   대상 스키마에 따라 다르다(standard 는 적용범위·정의 조항, case_event 는
 *   사고사진 비전 분석 서술) — 이 함수는 조합된 결과 문자열만 받는다.
 */
export async function findAndVerifyGpc(
  productName: string,
  productContext: string,
  candidateCount: number = DEFAULT_GPC_CANDIDATE_COUNT,
  /** 무엇에 붙이는 것인가. AI 호출 기록에 함께 남긴다(054) */
  target: { caseId?: number | null; standardId?: number | null } = {},
): Promise<GpcAssignment> {
  const candidates = await findGpcCandidates(productName, productContext, candidateCount);
  if (candidates.length === 0) {
    return { candidates: [], verification: NO_CANDIDATES_VERIFICATION };
  }

  const verification = await verifyGpcMatch(productContext, candidates, target);
  // candidates.length > 0 이므로 verifyGpcMatch() 는 여기서 null 을 반환하지 않는다
  // (그 함수의 null 분기는 candidates.length === 0 일 때뿐이다 — verify.ts 참고).
  return { candidates, verification: verification ?? NO_CANDIDATES_VERIFICATION };
}
