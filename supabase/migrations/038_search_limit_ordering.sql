-- =============================================================================
-- 상위 N건이 실제로 상위 N건이게 한다 — limit 앞에 정렬을 적는다
--
-- 무엇이 위태로웠나 (02 설계서 §1.3, 라운드 32 에서 찾은 것)
--   코드 갈래와 키워드 갈래는 등수를 매긴 뒤 상위 60건만 남긴다.
--
--     row_number() over (order by hit_full desc, ...) as rnk
--     from code_hits
--     limit greatest(p_match_count * 3, 60)
--
--   창 함수 안의 order by 는 등수를 계산하는 순서일 뿐, 바깥 limit 이 어느 행을
--   남길지는 정하지 않는다. SQL 표준은 바깥 order by 가 없는 limit 의 대상을
--   보장하지 않는다. 즉 "상위 60건"이 아니라 "아무 60건"이 될 수 있다.
--
--   세 번째 갈래인 vector_ranked 에는 명시적 order by 가 있어서 이 문제가 없다.
--   두 곳만 빠져 있었다.
--
-- 지금 틀린 결과가 나오고 있었는가
--   아마 아니다. PostgreSQL 의 WindowAgg 는 창 함수 정렬 순서대로 행을 내보내므로
--   실무에서는 의도대로 동작해 왔을 것이다. 그러나 그것은 구현이 그렇다는 것이지
--   약속된 동작이 아니다. 실행계획이 바뀌면(병렬 실행, 인덱스 변경, 판올림) 조용히
--   달라질 수 있고, 검색 결과가 조용히 달라지는 것은 이 체계에서 가장 나쁜 종류의
--   고장이다 — 아무도 오류를 보지 못한 채 잘못된 조항을 검토하게 된다.
--
--   그래서 "지금 문제가 없다"를 이유로 두지 않는다. 두 줄이면 보장으로 바뀐다.
--
-- 본체는 손으로 옮겨 적지 않았다
--   pg_get_functiondef() 로 DB 에서 그대로 뽑아 그 두 자리만 고쳤다. 140줄을
--   옮겨 적다 한 글자만 틀려도 검색 결과가 조용히 달라진다 — 032 와 같은 방식이다.
-- =============================================================================

-- 기본값 구성이 032 와 같아야 하므로 지우고 다시 만든다.
-- (13인자 호환 함수는 그대로 두고 14인자 본체만 바꾼다)
drop function if exists public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric, boolean
);

CREATE OR REPLACE FUNCTION public.clause_hybrid_search(p_query_text text, p_query_keywords text[], p_query_embedding extensions.vector(1536), p_hf_codes text[], p_dt_codes text[], p_standard_ids bigint[] DEFAULT NULL::bigint[], p_match_count integer DEFAULT 20, p_use_code boolean DEFAULT true, p_use_keyword boolean DEFAULT true, p_use_vector boolean DEFAULT true, p_rrf_k integer DEFAULT 60, p_w_code numeric DEFAULT 0.5, p_w_code_partial numeric DEFAULT 0.2, p_require_approved_tags boolean DEFAULT false)
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
