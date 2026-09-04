/**
 * 조항 태그 반려 사유 (037)
 *
 * 자유 텍스트로만 받으면 나중에 집계가 안 된다(설계문서 §7.2). 분석 후보의
 * 반려 사유(review-options.ts)와 같은 이유로 선택지로 받는다.
 *
 * 값은 037 의 체크 제약과 반드시 같아야 한다 — 한쪽만 늘리면 저장이 실패한다.
 */
export const CLAUSE_REJECT_REASONS = [
  { value: 'NOT_A_REQUIREMENT', label: '요건 조항이 아님 (정의·적용범위 등)' },
  { value: 'WRONG_CODE', label: '코드가 맞지 않음' },
  { value: 'NO_EVIDENCE', label: '근거 문구가 이 코드를 뒷받침하지 않음' },
  { value: 'TOO_BROAD', label: '지나치게 넓은 코드' },
] as const;

export const CLAUSE_REJECT_LABEL: Record<string, string> = Object.fromEntries(
  CLAUSE_REJECT_REASONS.map((r) => [r.value, r.label]),
);
