import { getDb } from '../db';
import { estimateCost, priceTable, addCost, type CostRange } from './pricing';

/**
 * AI 사용 현황 집계 (052)
 *
 * 화면이 답해야 하는 것은 셋이다.
 *   1) 어디에 어떤 모델을 쓰고 있나
 *   2) 얼마나 썼나
 *   3) 그중 무엇이 비싼가 — 고칠 곳을 정하는 재료다
 *
 * 단가가 등록되지 않은 모델은 금액을 0 으로 세지 않고 "모른다"고 말한다.
 * 모르는 것을 0 으로 적으면 비용이 실제보다 적어 보인다.
 */

/** 부른 자리를 담당자의 말로. 어느 화면·작업에서 도는지까지 적는다 */
export const PURPOSE_LABEL: Record<string, { name: string; where: string }> = {
  tagging:        { name: '위해요인 코드 부여', where: '사고보고서·리콜을 사건으로 만들 때' },
  rerank:         { name: '조항 재채점', where: '분석 실행 — 후보 조항을 다시 매길 때' },
  hyde:           { name: '가상 조항 생성', where: '분석 실행 — 의미 검색 질의를 다듬을 때' },
  scope_semantic: { name: '적용범위 의미검색', where: '품목 확정 — 사전에 없는 품목' },
  scope_filter:   { name: '적용범위 후보 거르기', where: '품목 확정 — 원문검색이 여럿 물어 왔을 때' },
  scope_suggest:  { name: '품목 기준 제안', where: '용어 사전 채우기' },
  gpc_verify:     { name: 'GPC 계위 검증', where: '품목분류 붙일 때' },
  alias:          { name: '검색어 생성', where: '검색어 사전 — AI로 검색어 더 만들기' },
  taxonomy_link:  { name: '법정 품목 → 기준 잇기', where: '대응표 만들 때' },
  embedding:      { name: '임베딩', where: '조항·사건·적용범위를 뜻으로 견주려고' },
};

export interface UsageRow {
  purpose: string;
  model: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  items: number;
  /** 단가가 등록되지 않았으면 null. 문맥 길이에 따라 단가가 갈리는 모델은 범위다 */
  costUsd: CostRange | null;
}

export interface UsageSummary {
  since: string;
  rows: UsageRow[];
  totalCalls: number;
  totalFailed: number;
  /**
   * 단가를 아는 것만 더한 값. 아는 것이 하나도 없으면 null.
   *
   * 0 을 돌려주면 화면에 "$0.01 미만"으로 떠서 "얼마 안 드네"로 읽힌다.
   * 모르는 것과 적게 쓴 것은 전혀 다른 말이다.
   */
  knownCost: CostRange | null;
  /** 단가를 몰라 금액에 못 넣은 모델들 */
  unpricedModels: string[];
  lastCallAt: string | null;
}

/** 최근 N일 사용 현황. 기본 30일 */
export async function usageSummary(days = 30): Promise<UsageSummary> {
  const db = getDb();

  const rows = await db<{
    purpose: string; model: string; calls: number; failed: number;
    input_tokens: number; output_tokens: number; reasoning_tokens: number; items: number;
  }[]>`
    select purpose, model,
           count(*)::int                                   calls,
           count(*) filter (where not ok)::int             failed,
           coalesce(sum(input_tokens), 0)::bigint::int     input_tokens,
           coalesce(sum(output_tokens), 0)::bigint::int    output_tokens,
           coalesce(sum(reasoning_tokens), 0)::bigint::int reasoning_tokens,
           coalesce(sum(item_count), 0)::bigint::int       items
    from public.llm_call
    where called_at >= now() - make_interval(days => ${days})
    group by purpose, model
    order by sum(input_tokens + output_tokens) desc
  `;

  const [last] = await db<{ at: string | null }[]>`
    select max(called_at)::text at from public.llm_call
  `;

  const table = priceTable();
  const unpriced = new Set<string>();
  let knownCost: CostRange = { min: 0, max: 0 };
  let pricedRows = 0;

  const mapped: UsageRow[] = rows.map((r) => {
    const cost = estimateCost(r.model, { inputTokens: r.input_tokens, outputTokens: r.output_tokens });
    if (cost === null) unpriced.add(r.model);
    else { knownCost = addCost(knownCost, cost); pricedRows++; }
    return {
      purpose: r.purpose,
      model: r.model,
      calls: r.calls,
      failed: r.failed,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      reasoningTokens: r.reasoning_tokens,
      items: r.items,
      costUsd: cost,
    };
  });

  return {
    since: `최근 ${days}일`,
    rows: mapped,
    totalCalls: mapped.reduce((a, r) => a + r.calls, 0),
    totalFailed: mapped.reduce((a, r) => a + r.failed, 0),
    // 단가를 아는 줄이 하나도 없으면 "0원"이 아니라 "모른다"
    knownCost: pricedRows > 0 ? knownCost : null,
    unpricedModels: [...unpriced].filter((m) => !table[m]),
    lastCallAt: last?.at ?? null,
  };
}
