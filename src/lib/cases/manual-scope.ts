import { getDb } from '../db';

/**
 * 담당자가 품목(적용 기준 세트)을 직접 정한다 (05_02 P1-2, 2026-10-07)
 *
 * 왜 필요한가
 *   품목은 대부분 이미 차려져 있다 — 수집 배치의 자동 판정(scope_evidence)과 원본 GPC로
 *   해외 리콜 2,331건이 분류돼 있다(lib/cases/classified.ts, 2026-10-07). 사람이 고를 일은
 *   셋 다 없는 68건과, 자동 판정이 틀렸다고 볼 때뿐이다. 화면은 "품목 등록 후 재실행"이라고
 *   안내하면서 그 둘을 정할 방법을 주지 않았다.
 *
 *   (처음 이 파일을 쓸 때는 등록 품목 칸만 보고 "40건(1.7%)만 정해졌다"고 적었다. 칸 하나만
 *   본 오판이었다 — CLAUDE.md §16 의 실제 사례다.)
 *
 * 사람의 판단을 배치가 덮지 않게 한다
 *   scope_evidence 가 이 머리말로 시작하면 담당자가 정한 것이다. load.ts 는 이 행의
 *   품목을 다시 쓰지 않는다 — gpc_source='EXPERT' 를 덮지 않는 것과 같은 규칙이다.
 */
export const MANUAL_SCOPE_PREFIX = '담당자 지정';

export interface ScopeOption {
  id: number;
  name: string;
  category: string | null;
}

export async function listProductScopes(): Promise<ScopeOption[]> {
  return getDb()<ScopeOption[]>`
    select id::int, name, category from public.product_scope order by category nulls last, name
  `;
}

/** scopeId 가 null 이면 담당자 지정을 풀어, 다음 수집 때 배치가 다시 정할 수 있게 한다 */
export async function setManualScope(caseId: number, scopeId: number | null, note: string | null): Promise<void> {
  const evidence = scopeId == null ? null : note ? `${MANUAL_SCOPE_PREFIX} — ${note}` : MANUAL_SCOPE_PREFIX;
  await getDb()`
    update public.case_event
    set product_scope_id = ${scopeId}, scope_evidence = ${evidence}
    where id = ${caseId}
  `;
}
