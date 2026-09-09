/**
 * 품목분류가 어디서 왔는가 — 출처와 그 서열 (065)
 *
 * 담당자 지적에서 나왔다. "OECD 포털이 보내는 segment/family/class/brick 코드는
 * 각 나라들이 OECD 포털에 등록할 때 사용하는 코드로 신빙성이 매우 높습니다."
 *
 * 맞는 말이고, 우리가 그것을 버리고 있었다. 원본 표에 코드가 와 있는데도 읽지
 * 않고 필요할 때마다 우리 AI 로 다시 붙였다 — 신고된 값을 놔두고 추정한 셈이다.
 *
 * 출처를 적지 않으면 좋은 값과 추정이 섞인다
 *   섞이면 두 가지가 망가진다. 첫째, 배치를 다시 돌릴 때 낮은 출처가 높은 출처를
 *   덮는다. 둘째, 검수 화면이 「이건 확인해야 하는 값인가」를 말해 줄 수 없다 —
 *   등록국이 신고한 코드와 우리 AI 가 짐작한 코드를 같은 얼굴로 보여 주게 된다.
 */

export const GPC_SOURCES = ['EXPERT', 'OECD', 'SOURCE_AI', 'OUR_AI'] as const;
export type GpcSource = (typeof GPC_SOURCES)[number];

/**
 * 서열 — 큰 값이 이긴다.
 *
 * 담당자 확정이 맨 위인 것은 다른 규칙과 같다(사람이 정한 것을 기계가 덮지 않는다).
 * 그 아래가 등록국 신고다 — 그 나라의 규제기관이 자기 리콜을 등록하며 직접 고른
 * 코드라, 제품을 실제로 들여다본 쪽이 붙인 값이다.
 */
const RANK: Record<GpcSource, number> = {
  EXPERT: 40,
  OECD: 30,
  SOURCE_AI: 20,
  OUR_AI: 10,
};

export const GPC_SOURCE_LABEL: Record<GpcSource, string> = {
  EXPERT: '담당자 확정',
  OECD: '등록국이 신고',
  SOURCE_AI: '리콜 원본 시스템이 부여',
  OUR_AI: '이 체계가 부여',
};

export const GPC_SOURCE_NOTE: Record<GpcSource, string> = {
  EXPERT: '담당자가 직접 확정한 코드입니다.',
  OECD: '리콜을 낸 나라가 OECD 포털에 등록하며 직접 고른 코드입니다. 제품을 실제로 조사한 쪽이 붙인 값이라 신빙성이 높습니다.',
  SOURCE_AI: '해외 리콜을 모아 주는 원본 시스템이 자동으로 붙인 코드입니다. 참고용입니다.',
  OUR_AI: '이 체계가 적용범위·설명을 견줘 붙인 코드입니다. 검수가 필요합니다.',
};

export function rankOf(source: string | null | undefined): number {
  return RANK[source as GpcSource] ?? 0;
}

/** 새 출처가 기존 출처를 덮어도 되는가. 같은 서열이면 덮는다(최신값을 쓴다) */
export function mayOverwrite(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): boolean {
  return rankOf(incoming) >= rankOf(existing);
}

/** 사람이 다시 확인할 필요가 있는 출처인가 */
export function needsReview(source: string | null | undefined): boolean {
  return rankOf(source) <= RANK.SOURCE_AI;
}
