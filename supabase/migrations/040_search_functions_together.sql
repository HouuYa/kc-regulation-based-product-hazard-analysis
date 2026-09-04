-- =============================================================================
-- 검색 함수 두 개를 한 파일에서 함께 만든다 — 갈라져서 사고가 났다
--
-- 무엇이 잘못됐나 (038·039 를 넣고 확인하다 드러난 것)
--   clause_hybrid_search 는 두 개가 짝을 이뤄야 한다.
--
--     14인자 본체   기본값이 **없어야** 한다
--     13인자 호환   기본값을 갖고, 본체를 부른다
--
--   14인자에 기본값이 있으면 13인자 호출이 어느 쪽인지 정해지지 않는다.
--
--     ERROR: function public.clause_hybrid_search(...) is not unique
--
--   032 는 이 둘을 한 파일에서 함께 만들어 짝이 맞았다. 그런데 그 뒤로
--   갈라졌다 —
--
--     030 재적용   13인자를 지우고, 14인자를 기본값과 함께 다시 만들었다
--     038          그 상태의 14인자를 그대로 떠서(기본값 포함) 정렬만 고쳤다
--     039          13인자를 되살렸다 → 기본값이 붙은 14인자와 겹쳐 모호해졌다
--
--   한쪽만 고치는 파일을 두 번 쓴 것이 원인이다. 둘은 따로 존재할 수 없는데
--   따로 고칠 수 있게 두었다.
--
-- 규칙
--   앞으로 clause_hybrid_search 를 바꿀 때는 **이 파일을 통째로 복사해 새 번호로
--   만들고 본체만 손본다.** 두 함수를 각각 다른 파일에서 건드리지 않는다.
--   그리고 그 파일이 마이그레이션 중 가장 큰 번호여야 한다 — 030 에 13인자를
--   지우는 문장이 남아 있어서, 순서가 결과를 바꾸기 때문이다.
--
--   본체는 손으로 옮겨 적지 않는다. pg_get_functiondef() 로 떠서 필요한 자리만
--   고친다. 140줄을 옮겨 적다 한 글자만 틀려도 검색 결과가 조용히 달라진다.
-- =============================================================================

drop function if exists public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric, boolean
);

CREATE OR REPLACE FUNCTION public.clause_hybrid_search(p_query_text text, p_query_keywords text[], p_query_embedding extensions.vector(1536), p_hf_codes text[], p_dt_codes text[], p_standard_ids bigint[], p_match_count integer, p_use_code boolean, p_use_keyword boolean, p_use_vector boolean, p_rrf_k integer, p_w_code numeric, p_w_code_partial numeric, p_require_approved_tags boolean)
 RETURNS TABLE(clause_id bigint, score numeric, match_path text, rank_code integer, rank_keyword integer, rank_vector integer, code_hit_full integer, code_hit_partial integer)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with
-- 후보 모집단 — 품목/기준 한정. 개정 전 판은 제외한다
base as (
  select c.id, c.search_text, c.keywords
  from public.clause c
  join public.standard s on s.id = c.standard_id
  where s.is_current
    and (p_standard_ids is null or c.standard_id = any (p_standard_ids))
),

-- ① 코드 매칭 — HF/DT 교집합 (§5.1 ①)
--    근거가 명확하고 통계 집계가 가능한 유일한 갈래다.
--
--    질의 코드를 축과 함께 펴 놓고 조인한다. 집계 FILTER 안에 상관 서브쿼리를
--    넣는 방식보다 읽기 쉽고, 어느 태그가 왜 걸렸는지 그대로 드러난다.
query_codes as (
  select 'HF'::text as axis, c as code from unnest(coalesce(p_hf_codes, '{}')) c
  union all
  select 'DT'::text, c from unnest(coalesce(p_dt_codes, '{}')) c
),
tag_match as (
  select
    t.clause_id,
    case when q.code = t.code then 'FULL' else 'PARTIAL' end as kind
  from public.clause_tag t
  join base b on b.id = t.clause_id
  join query_codes q
    on q.axis = t.axis
   -- 어느 쪽이 더 굵든 상위 계위가 겹치면 부분 일치로 본다 (HF.M.* 대응)
   and (q.code = t.code or q.code like t.code || '.%' or t.code like q.code || '.%')
  where p_use_code
    -- 검수에서 반려된 태깅은 매칭에 쓰지 않는다
    and t.review_status <> 'rejected'
    -- 스위치를 켜면 검수 확정분만 쓴다(030). 미검수 자동 태그는 코드 갈래에서
    -- 빠지므로 가산점도 받지 않는다. 기본값 false 는 기존 동작 그대로다.
    and (not p_require_approved_tags or t.review_status = 'approved')
),
code_hits as (
  select
    clause_id,
    count(*) filter (where kind = 'FULL')::int    as hit_full,
    count(*) filter (where kind = 'PARTIAL')::int as hit_partial
  from tag_match
  group by clause_id
),
code_ranked as (
  select
    clause_id, hit_full, hit_partial,
    row_number() over (order by hit_full desc, hit_partial desc, clause_id)::int as rnk
  from code_hits
  -- limit 은 어떤 순서로 나온 행을 자를지 스스로 정하지 않는다. 창 함수의
  -- 정렬과 같은 순서를 바깥에도 적어 주어야 "상위 N건"이 보장된다(038)
  order by rnk
  limit greatest(p_match_count * 3, 60)
),

-- ② 키워드 매칭 — 한국어 전문검색 (§5.1 ②, §5.3)
--    거르기는 PGroonga 인덱스로(빠름), 순위는 "몇 개 용어가 맞았는가"로 매긴다.
--    순위 근거가 사람이 읽어서 이해되는 값이어야 화면에서 설명할 수 있다(§5.7).
keyword_hits as (
  select
    b.id as clause_id,
    (
      (select count(*) from unnest(coalesce(p_query_keywords, '{}')) k
        where b.search_text ilike '%' || k || '%')
      + coalesce(cardinality(array(
          select unnest(b.keywords) intersect select unnest(coalesce(p_query_keywords, '{}'))
        )), 0)
    )::int as hit_count
  from base b
  where p_use_keyword
    and coalesce(cardinality(p_query_keywords), 0) > 0
    and (
      -- PGroonga 는 OR 를 대문자로 쓴다
      (b.search_text is not null
        and b.search_text OPERATOR(extensions.&@~) array_to_string(p_query_keywords, ' OR '))
      -- 태깅 단계 산출물을 그대로 쓰는 병행 경로 (§5.3 방안 C)
      or b.keywords && p_query_keywords
    )
),
keyword_ranked as (
  select clause_id, row_number() over (order by hit_count desc, clause_id)::int as rnk
  from keyword_hits
  where hit_count > 0
  order by rnk
  limit greatest(p_match_count * 3, 60)
),

-- ③ 의미 매칭 — 벡터 유사도 (§5.1 ③)
--    표현이 달라도 잡지만 왜 나왔는지 설명이 약하다. 그래서 혼자 쓰지 않는다.
vector_ranked as (
  select
    c.id as clause_id,
    row_number() over (
      order by c.embedding OPERATOR(extensions.<=>) p_query_embedding
    )::int as rnk
  from public.clause c
  join base b on b.id = c.id
  where p_use_vector
    and p_query_embedding is not null
    and c.embedding is not null
  order by c.embedding OPERATOR(extensions.<=>) p_query_embedding
  limit greatest(p_match_count * 3, 60)
),

-- ④ 융합 — 등수를 점수로 바꿔 더한다 (§5.4)
fused as (
  select
    coalesce(cr.clause_id, kr.clause_id, vr.clause_id) as clause_id,
    cr.rnk as rank_code,
    kr.rnk as rank_keyword,
    vr.rnk as rank_vector,
    coalesce(cr.hit_full, 0)    as hit_full,
    coalesce(cr.hit_partial, 0) as hit_partial,
    (
        coalesce(1.0 / (p_rrf_k + cr.rnk), 0)
      + coalesce(1.0 / (p_rrf_k + kr.rnk), 0)
      + coalesce(1.0 / (p_rrf_k + vr.rnk), 0)
      -- 코드 가산 — 코드 일치만이 통계와 근거 제시에 쓸 수 있는 갈래이므로 우대한다
      + case when coalesce(cr.hit_full, 0)    > 0 then p_w_code         else 0 end
      + case when coalesce(cr.hit_partial, 0) > 0 then p_w_code_partial else 0 end
    )::numeric as score
  from code_ranked cr
  full outer join keyword_ranked kr on kr.clause_id = cr.clause_id
  full outer join vector_ranked  vr on vr.clause_id = coalesce(cr.clause_id, kr.clause_id)
)
select
  f.clause_id,
  f.score,
  case
    -- 미태깅 조항은 코드 갈래 자체가 없다 → 폴백임을 명시한다 (§5.4)
    when not exists (select 1 from public.clause_tag t where t.clause_id = f.clause_id)
      then 'FALLBACK'
    when f.hit_full > 0    then 'CODE'
    when f.hit_partial > 0 then 'CODE-PARTIAL'
    -- 코드 근거 없음 — 화면에 그렇게 표시해야 한다 (§5.4)
    else 'HYBRID'
  end as match_path,
  f.rank_code,
  f.rank_keyword,
  f.rank_vector,
  f.hit_full,
  f.hit_partial
from fused f
order by f.score desc, f.clause_id
limit p_match_count;
$function$;


-- -----------------------------------------------------------------------------
-- 13인자 호환 — 옛 코드가 부르는 방식
--
-- 배포는 스키마가 먼저 나가고 코드가 나중에 따라온다. 그 사이에는 늘 옛 코드와
-- 새 스키마가 함께 도는 구간이 있고, 그때 이것이 없으면 분석이 죽는다.
-- 실제로 한 번 겪었다(032 참고).
-- -----------------------------------------------------------------------------
create or replace function public.clause_hybrid_search(
  p_query_text       text,
  p_query_keywords   text[],
  p_query_embedding  extensions.vector(1536),
  p_hf_codes         text[],
  p_dt_codes         text[],
  p_standard_ids     bigint[] default null,
  p_match_count      int     default 20,
  p_use_code         boolean default true,
  p_use_keyword      boolean default true,
  p_use_vector       boolean default true,
  p_rrf_k            int     default 60,
  p_w_code           numeric default 0.5,
  p_w_code_partial   numeric default 0.2
)
returns table (
  clause_id     bigint,
  score         numeric,
  match_path    text,
  rank_code     int,
  rank_keyword  int,
  rank_vector   int,
  code_hit_full int,
  code_hit_partial int
)
language sql
stable
security invoker
set search_path = ''
as $compat$
  -- 검수 확정분만 쓰는 스위치는 끈 상태로 넘긴다. 007 이후의 동작과 같다
  select * from public.clause_hybrid_search(
    p_query_text, p_query_keywords, p_query_embedding,
    p_hf_codes, p_dt_codes, p_standard_ids, p_match_count,
    p_use_code, p_use_keyword, p_use_vector,
    p_rrf_k, p_w_code, p_w_code_partial,
    false
  );
$compat$;

revoke execute on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric
) from public;
revoke execute on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric
) from anon, authenticated;
grant execute on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric
) to service_role;

revoke execute on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric, boolean
) from public;
revoke execute on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric, boolean
) from anon, authenticated;
grant execute on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric, boolean
) to service_role;
