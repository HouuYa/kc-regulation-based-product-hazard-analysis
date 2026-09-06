/**
 * 검색어의 위험을 진단한다 — 잘못 붙은 별칭을 찾아내는 장치
 *
 * 왜 필요한가 (2026-09-06 실측)
 *   별칭이 틀리면 엉뚱한 품목으로 인식되고, 그러면 엉뚱한 기준의 시험이 담당자에게
 *   근거로 제시된다. 조용히 틀리는 종류의 고장이다.
 *
 *   실제로 사람이 만든 사전에도 이런 줄이 있다.
 *     "고압세척기" → 진공청소기
 *     "베개"      → 1286 (품목 코드가 이름 자리에 들어간 오류)
 *
 *   세어 보니 검색어 5,982개 중 **600개가 여러 품목에 걸쳐 있다**(1,365줄).
 *   그리고 실제 사고·리콜 품목명에 걸리는 것은 382개뿐이다. 나머지는 아직 아무것도
 *   안 걸리므로, 검수는 **실제로 걸리는 것부터** 해야 한다.
 *
 * 무엇을 재는가 — 셋
 *   충돌   같은 말이 여러 품목에 붙어 있다. 자동으로 쓰면 어느 품목인지 정할 수 없다
 *   과매칭 다른 검색어를 통째로 품는다("세척기"가 "고압세척기"를 품는다).
 *          짧은 말일수록 위험하다
 *   실사용 실제 사고·리콜 품목명에 걸리는가. 안 걸리면 검수 우선순위가 낮고,
 *          걸리는데 이상하면 가장 급하다
 *
 * 진단만 한다
 *   여기서 지우거나 고치지 않는다. 담당자가 화면에서 보고 정한다.
 */

import { getDb } from '../db';

/** 이보다 짧으면 다른 말에 쉽게 걸린다 */
const SHORT_KEYWORD = 3;

export interface KeywordRisk {
  id: number;
  keyword: string;
  itemGroup: string;
  target: string;
  source: string;
  reviewStatus: string;
  /** 이 말이 붙어 있는 품목 수. 2 이상이면 충돌 */
  targetCount: number;
  /** 충돌하는 다른 품목들 */
  otherTargets: string[];
  /** 이 말을 부분으로 품는 다른 검색어 수 — 많을수록 넓게 걸린다 */
  swallows: number;
  /** 실제 사고·리콜 품목명에 걸린 건수 */
  usedBy: number;
  /** 걸린 품목명 예시 */
  usedExamples: string[];
  /** 사람이 봐야 할 순서 — 큰 것부터 */
  score: number;
}

export interface RiskSummary {
  total: number;
  conflicts: number;
  shortWords: number;
  used: number;
  unreviewed: number;
}

export async function riskSummary(): Promise<RiskSummary> {
  const [r] = await getDb()<{
    total: string; conflicts: string; short_words: string; used: string; unreviewed: string;
  }[]>`
    select
      (select count(*) from public.item_keyword where review_status <> 'rejected')::text total,
      (select count(*) from (
        select keyword_key from public.item_keyword
        where review_status <> 'rejected'
        group by keyword_key
        having count(distinct coalesce(sub_item, item)) > 1) x)::text conflicts,
      (select count(*) from public.item_keyword
        where review_status <> 'rejected' and length(keyword) <= ${SHORT_KEYWORD})::text short_words,
      (select count(distinct k.id) from public.item_keyword k
        join public.case_event ce on public.scope_term_key(ce.item_name) = k.keyword_key
        where k.review_status <> 'rejected' and ce.item_name is not null)::text used,
      (select count(*) from public.item_keyword where review_status = 'auto_unreviewed')::text unreviewed
  `;
  return {
    total: Number(r.total),
    conflicts: Number(r.conflicts),
    shortWords: Number(r.short_words),
    used: Number(r.used),
    unreviewed: Number(r.unreviewed),
  };
}

/**
 * 위험한 검색어를 순서대로 돌려준다.
 *
 * 순서를 정하는 규칙 — 담당자 시간이 가장 비싼 자원이다
 *   1) 실제로 걸리는 것이 먼저다. 아무것도 안 걸리는 말은 틀려도 지금은 해가 없다
 *   2) 그중 충돌하는 것이 먼저다. 어느 품목인지 정할 수 없는 상태다
 *   3) 그중 넓게 걸리는 것(다른 검색어를 품는 것)이 먼저다
 */
export async function riskyKeywords(opts: {
  onlyConflict?: boolean;
  onlyUsed?: boolean;
  limit?: number;
} = {}): Promise<KeywordRisk[]> {
  const db = getDb();

  const rows = await db<{
    id: number; keyword: string; item_group: string; target: string;
    source: string; review_status: string;
    target_count: string; other_targets: string[] | null;
    swallows: string; used_by: string; used_examples: string[] | null;
  }[]>`
    with live as (
      select id, keyword, keyword_key, item_group,
             coalesce(sub_item, item, '') target, source, review_status
      from public.item_keyword
      where review_status <> 'rejected'
    ),
    -- 같은 말이 몇 품목에 붙었나
    conflict as (
      select keyword_key,
             count(distinct target)::int n,
             array_agg(distinct target) targets
      from live group by keyword_key
    ),
    -- 이 말을 부분으로 품는 다른 검색어가 몇 개인가.
    -- "세척기"는 "고압세척기"·"식기세척기"에 들어 있으므로 넓게 걸린다
    swallow as (
      select a.keyword_key,
             count(*)::int n
      from live a
      join live b
        on b.keyword_key <> a.keyword_key
       and position(a.keyword_key in b.keyword_key) > 0
      group by a.keyword_key
    ),
    -- 실제 사고·리콜 품목명에 걸리는가
    used as (
      select k.keyword_key,
             count(distinct ce.id)::int n,
             (array_agg(distinct ce.item_name))[1:3] examples
      from live k
      join public.case_event ce
        on public.scope_term_key(ce.item_name) = k.keyword_key
      where ce.item_name is not null
      group by k.keyword_key
    )
    select
      l.id, l.keyword, l.item_group, l.target, l.source, l.review_status,
      c.n::text target_count,
      array_remove(c.targets, l.target) other_targets,
      coalesce(s.n, 0)::text swallows,
      coalesce(u.n, 0)::text used_by,
      u.examples used_examples
    from live l
    join conflict c on c.keyword_key = l.keyword_key
    left join swallow s on s.keyword_key = l.keyword_key
    left join used u on u.keyword_key = l.keyword_key
    where (c.n > 1 or coalesce(s.n, 0) > 0 or length(l.keyword) <= ${SHORT_KEYWORD})
      ${opts.onlyConflict ? db`and c.n > 1` : db``}
      ${opts.onlyUsed ? db`and coalesce(u.n, 0) > 0` : db``}
    order by
      coalesce(u.n, 0) desc,   -- 실제로 걸리는 것 먼저
      c.n desc,                -- 충돌이 심한 것 먼저
      coalesce(s.n, 0) desc,   -- 넓게 걸리는 것 먼저
      l.keyword
    limit ${opts.limit ?? 100}
  `;

  return rows.map((r) => {
    const targetCount = Number(r.target_count);
    const swallows = Number(r.swallows);
    const usedBy = Number(r.used_by);
    return {
      id: r.id,
      keyword: r.keyword,
      itemGroup: r.item_group,
      target: r.target,
      source: r.source,
      reviewStatus: r.review_status,
      targetCount,
      otherTargets: r.other_targets ?? [],
      swallows,
      usedBy,
      usedExamples: r.used_examples ?? [],
      // 실제로 걸리는 것에 큰 가중치를 준다 — 지금 해를 끼치는 것이 급하다
      score: usedBy * 10 + (targetCount - 1) * 3 + Math.min(swallows, 10),
    };
  });
}
