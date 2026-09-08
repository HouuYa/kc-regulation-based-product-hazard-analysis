import { getDb } from '../db';
import { estimateCost, priceTable, addCost, type CostRange } from './pricing';
import { CALL_SITES } from './catalog';

/**
 * AI 사용 현황 집계 (052 · 054 확장)
 *
 * 화면이 답해야 하는 것은 넷이다.
 *   1) 어디에 어떤 모델을 쓰고 있나        → catalog.ts (코드가 곧 표다)
 *   2) 얼마나 썼나                          → usageSummary
 *   3) 그중 무엇이 비싼가                   → 용도별·모델별 집계
 *   4) 늘고 있나 줄고 있나                  → dailyUsage
 *
 * 단가가 등록되지 않은 모델은 금액을 0 으로 세지 않고 "모른다"고 말한다.
 * 모르는 것을 0 으로 적으면 비용이 실제보다 적어 보인다.
 */

/** 부른 자리를 담당자의 말로. 목록은 catalog.ts 하나에서 온다 */
export const PURPOSE_LABEL: Record<string, { name: string; where: string }> =
  Object.fromEntries(CALL_SITES.map((s) => [s.purpose, { name: s.name, where: s.when }]));

export interface UsageRow {
  purpose: string;
  model: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** 입력 토큰 중 캐시 적중분. 입력에 포함된 값이다(054) */
  cachedTokens: number;
  items: number;
  /** 단가가 등록되지 않았으면 null. 문맥 길이에 따라 단가가 갈리는 모델은 범위다 */
  costUsd: CostRange | null;
}

export interface UsageSummary {
  since: string;
  days: number;
  rows: UsageRow[];
  /** 같은 것을 모델 기준으로 묶은 것 — "무엇이 비싼가"는 용도로, "어떤 모델을 쓰나"는 이쪽으로 본다 */
  byModel: UsageRow[];
  totalCalls: number;
  totalFailed: number;
  totalInput: number;
  totalOutput: number;
  totalCached: number;
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

interface RawRow {
  purpose: string; model: string; calls: number; failed: number;
  input_tokens: number; output_tokens: number; reasoning_tokens: number;
  cached_tokens: number; items: number;
}

function toRow(r: RawRow): UsageRow {
  return {
    purpose: r.purpose,
    model: r.model,
    calls: r.calls,
    failed: r.failed,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    reasoningTokens: r.reasoning_tokens,
    cachedTokens: r.cached_tokens,
    items: r.items,
    costUsd: estimateCost(r.model, {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cachedTokens: r.cached_tokens,
    }),
  };
}

/** 최근 N일 사용 현황. 기본 30일 */
export async function usageSummary(days = 30): Promise<UsageSummary> {
  const db = getDb();

  const rows = await db<RawRow[]>`
    select purpose, model,
           count(*)::int                                   calls,
           count(*) filter (where not ok)::int             failed,
           coalesce(sum(input_tokens), 0)::bigint::int     input_tokens,
           coalesce(sum(output_tokens), 0)::bigint::int    output_tokens,
           coalesce(sum(reasoning_tokens), 0)::bigint::int reasoning_tokens,
           coalesce(sum(cached_tokens), 0)::bigint::int    cached_tokens,
           coalesce(sum(item_count), 0)::bigint::int       items
    from public.llm_call
    where called_at >= now() - make_interval(days => ${days})
    group by purpose, model
    order by sum(input_tokens + output_tokens) desc
  `;

  const modelRows = await db<RawRow[]>`
    select '' purpose, model,
           count(*)::int                                   calls,
           count(*) filter (where not ok)::int             failed,
           coalesce(sum(input_tokens), 0)::bigint::int     input_tokens,
           coalesce(sum(output_tokens), 0)::bigint::int    output_tokens,
           coalesce(sum(reasoning_tokens), 0)::bigint::int reasoning_tokens,
           coalesce(sum(cached_tokens), 0)::bigint::int    cached_tokens,
           coalesce(sum(item_count), 0)::bigint::int       items
    from public.llm_call
    where called_at >= now() - make_interval(days => ${days})
    group by model
    order by sum(input_tokens + output_tokens) desc
  `;

  const [last] = await db<{ at: string | null }[]>`
    select max(called_at)::text at from public.llm_call
  `;

  const table = priceTable();
  const unpriced = new Set<string>();
  let knownCost: CostRange = { min: 0, max: 0 };
  let pricedRows = 0;

  const mapped = rows.map((r) => {
    const row = toRow(r);
    if (row.costUsd === null) unpriced.add(r.model);
    else { knownCost = addCost(knownCost, row.costUsd); pricedRows++; }
    return row;
  });

  const sum = (pick: (r: UsageRow) => number) => mapped.reduce((a, r) => a + pick(r), 0);

  return {
    since: `최근 ${days}일`,
    days,
    rows: mapped,
    byModel: modelRows.map(toRow),
    totalCalls: sum((r) => r.calls),
    totalFailed: sum((r) => r.failed),
    totalInput: sum((r) => r.inputTokens),
    totalOutput: sum((r) => r.outputTokens),
    totalCached: sum((r) => r.cachedTokens),
    // 단가를 아는 줄이 하나도 없으면 "0원"이 아니라 "모른다"
    knownCost: pricedRows > 0 ? knownCost : null,
    unpricedModels: [...unpriced].filter((m) => !table[m]),
    lastCallAt: last?.at ?? null,
  };
}

export interface DayUsage {
  day: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: CostRange | null;
}

/**
 * 날짜별 사용량 — 「늘고 있나」를 본다.
 *
 * 금액은 그날 쓴 모델별로 따로 계산해서 더한다. 하루치를 뭉쳐 한 모델 단가로 매기면
 * 싼 모델과 비싼 모델이 섞인 날의 금액이 엉뚱해진다.
 */
export async function dailyUsage(days = 14): Promise<DayUsage[]> {
  const db = getDb();
  const rows = await db<{
    day: string; model: string; calls: number; failed: number;
    input_tokens: number; output_tokens: number; cached_tokens: number;
  }[]>`
    -- day 는 예약어에 가까워 별칭으로 그냥 쓰면 구문 오류가 난다. as 를 붙인다
    select to_char(called_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') as day,
           model,
           count(*)::int                                calls,
           count(*) filter (where not ok)::int          failed,
           coalesce(sum(input_tokens), 0)::bigint::int  input_tokens,
           coalesce(sum(output_tokens), 0)::bigint::int output_tokens,
           coalesce(sum(cached_tokens), 0)::bigint::int cached_tokens
    from public.llm_call
    where called_at >= now() - make_interval(days => ${days})
    group by 1, 2
    order by 1
  `;

  const byDay = new Map<string, DayUsage>();
  for (const r of rows) {
    const cur = byDay.get(r.day) ?? {
      day: r.day, calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0,
      cost: { min: 0, max: 0 } as CostRange | null,
    };
    cur.calls += r.calls;
    cur.failed += r.failed;
    cur.inputTokens += r.input_tokens;
    cur.outputTokens += r.output_tokens;
    cur.cachedTokens += r.cached_tokens;
    const c = estimateCost(r.model, {
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, cachedTokens: r.cached_tokens,
    });
    // 단가를 모르는 모델이 하루에 하나라도 섞이면 그날 금액은 "모른다"로 둔다
    cur.cost = c === null || cur.cost === null ? null : addCost(cur.cost, c);
    byDay.set(r.day, cur);
  }
  return [...byDay.values()];
}

export interface RecentCall {
  at: string;
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  items: number;
  ok: boolean;
  error: string | null;
  caseId: number | null;
  standardId: number | null;
}

/** 최근 호출 몇 건 — 방금 돌린 작업이 실제로 무엇을 불렀는지 확인하는 자리 */
export async function recentCalls(limit = 20): Promise<RecentCall[]> {
  const db = getDb();
  const rows = await db<{
    at: string; purpose: string; model: string;
    input_tokens: number; output_tokens: number; cached_tokens: number;
    item_count: number; ok: boolean; error: string | null;
    case_id: number | null; standard_id: number | null;
  }[]>`
    select called_at::text at, purpose, model, input_tokens, output_tokens, cached_tokens,
           item_count, ok, error, case_id, standard_id
    from public.llm_call
    order by called_at desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    at: r.at,
    purpose: r.purpose,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedTokens: r.cached_tokens,
    items: r.item_count,
    ok: r.ok,
    error: r.error,
    caseId: r.case_id === null ? null : Number(r.case_id),
    standardId: r.standard_id === null ? null : Number(r.standard_id),
  }));
}
