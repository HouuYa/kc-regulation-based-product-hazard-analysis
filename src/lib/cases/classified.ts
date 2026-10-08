import { getDb } from '../db';

/**
 * 「품목이 분류된 사건」의 정의 — 한 곳에만 둔다 (2026-10-07)
 *
 * 왜 따로 뽑았나
 *   라운드 83에서 리콜 1단계를 만들며 `product_scope_id`(등록 품목 33종)만 보고 "품목 미정"을
 *   셌다. 그러자 해외 리콜 2,359건이 "직접 정하라"로 떴다. 그런데 실제로는 수집 배치
 *   (lib/recall/load.ts → resolveProductScope)가 새 리콜마다 용어 사전·검색어 사전·적용범위
 *   검색·의미 검색으로 품목을 이미 판정해 `scope_evidence` 에 남기고 있었다(2,081/2,399건).
 *   원본 DB 의 GPC 분류(1,939건)도 있었다. 사람은 검토만 하고 LLM·배치가 재료를 최대한
 *   차려 둔다는 이 체계의 원칙을 화면이 거스른 셈이다. 같은 칸을 화면·홈·정책 현황판이
 *   따로 세면 또 갈리므로 여기 한 벌만 둔다(CLAUDE.md §9).
 *
 * 분류됨 = 셋 중 하나라도 있다
 *   1) 담당자가 품목을 정했다            product_scope_id
 *   2) 자동 품목 판정이 적용 기준을 찾았다  scope_evidence (load.ts·tag-cases 가 판정 성공 때만 쓴다)
 *   3) 원본 DB 가 품목분류(GPC)를 보냈다   gpc_brick_code + 출처 EXPERT·OECD (gpc/provenance.ts)
 *
 * 실측(2026-10-07): 셋 다 없는 것은 해외 리콜 68건, 사고보고서 6건.
 */
export function classifiedSql(alias = 'e') {
  const db = getDb();
  const a = db.unsafe(alias);
  return db`(${a}.product_scope_id is not null
             or ${a}.scope_evidence is not null
             or (${a}.gpc_brick_code is not null and ${a}.gpc_source in ('EXPERT', 'OECD')))`;
}

/** scope_evidence 앞머리("용어 사전 — …")에서 판정 경로 이름만 뽑는다. 화면 표시용 */
export function scopeMethodOf(evidence: string | null): string | null {
  if (!evidence) return null;
  const head = evidence.split(' — ')[0].trim();
  return head.length > 0 && head.length <= 20 ? head : '자동 판정';
}
