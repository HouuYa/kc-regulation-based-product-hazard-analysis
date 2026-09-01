/**
 * 반려 사유 선택지 (설계문서 §7.2)
 *
 * "자유 텍스트만 받으면 나중에 집계가 안 된다."
 * 그래서 사유를 고정된 선택지로 받는다. DB 의 check 제약과 이 목록이 같아야 하므로
 * 한쪽만 고치면 저장이 거부된다 — 그 편이 조용히 어긋나는 것보다 낫다.
 *
 * 'use server' 파일은 async 함수만 내보낼 수 있어 이 상수를 따로 둔다.
 */

export type Decision = 'ADOPTED' | 'REJECTED' | 'MODIFIED';
export type RejectReason = 'NOT_RELATED' | 'ALREADY_TESTED' | 'WRONG_CLAUSE' | 'LOW_PRIORITY';

export const REJECT_REASONS: Array<{ value: RejectReason; label: string }> = [
  { value: 'NOT_RELATED',    label: '관련 없음' },
  { value: 'ALREADY_TESTED', label: '이미 실시' },
  { value: 'WRONG_CLAUSE',   label: '조항 오류' },
  { value: 'LOW_PRIORITY',   label: '우선순위 낮음' },
];
