-- =============================================================================
-- 배포 순서가 어긋나도 검색이 죽지 않게 한다 — 13인자 호환 함수를 되살린다
--
-- 무엇이 잘못됐나 (실제로 일어난 일)
--   030 을 프로덕션 DB 에 적용하면서 옛 13인자 clause_hybrid_search 를 지우고
--   14인자짜리로 바꿨다. 그런데 그 시점에 배포된 사이트는 아직 13인자로 부르는
--   옛 코드였다. 스키마만 앞서 나가고 코드가 따라오지 않은 것이다.
--
--   결과: 배포 사이트에서 분석 실행이 "function does not exist" 로 죽는다.
--   화면은 멀쩡해 보이고 버튼을 눌러야 드러나므로 알아채기까지 시간이 걸린다.
--
-- 왜 "다음에 배포하면 된다"로 끝내지 않는가
--   스키마를 먼저 적용하고 코드를 나중에 올리는 것은 예외가 아니라 정상 순서다.
--   두 시점 사이에는 늘 옛 코드와 새 스키마가 함께 도는 구간이 있다. 그 구간에서
--   기능이 죽지 않으려면 옛 호출 방식이 살아 있어야 한다. 이번 한 번을 넘기는
--   임시 조치가 아니라, 앞으로도 지켜야 할 규칙이다.
--
-- 왜 기본값을 없애야 하는가 (실측으로 확인)
--   14인자 함수의 마지막 인자에 기본값이 있는 채로 13인자 함수를 함께 두면
--   13인자 호출이 어느 쪽인지 정해지지 않는다. 실제로 확인했다.
--
--     ERROR: function public._tov(integer) is not unique
--
--   그래서 14인자 본체에서는 기본값을 전부 없애고, 짧은 호출은 13인자 래퍼가
--   받도록 나눴다. 이렇게 하면 13인자 이하 호출은 래퍼만, 14인자를 다 채운
--   호출은 본체만 맞아 겹치지 않는다.
--
--   마지막 인자의 기본값만 떼는 방법은 쓸 수 없다 — PostgreSQL 은 기본값이 있는
--   인자 뒤에 기본값 없는 인자를 두지 못하게 한다. 실제로 걸렸다.
--
--   아래 본체는 030 이 만든 것을 DB 에서 그대로 뽑아 마지막 인자의 기본값만
--   떼어 낸 것이다. 손으로 옮겨 적지 않았다 — 옮겨 적다 한 글자만 틀려도
--   검색 결과가 조용히 달라진다.
-- =============================================================================

-- 기본값은 create or replace 로 떼어 낼 수 없다("cannot remove parameter defaults
-- from existing function"). 지우고 다시 만든다. db-push 가 파일 하나를 한
-- 트랜잭션으로 실행하므로 함수가 비는 구간은 밖에서 보이지 않는다.
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
-- 검수 확정 태그만 쓰는 스위치는 끈 상태로 넘긴다. 030 이 정한 기본값과 같고,
-- 007 이후 줄곧 해 오던 동작과도 같다. 즉 옛 코드는 예전과 똑같이 동작한다.
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
  select * from public.clause_hybrid_search(
    p_query_text, p_query_keywords, p_query_embedding,
    p_hf_codes, p_dt_codes, p_standard_ids, p_match_count,
    p_use_code, p_use_keyword, p_use_vector,
    p_rrf_k, p_w_code, p_w_code_partial,
    false
  );
$compat$;

comment on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric
) is
  '13인자 호환 진입점(032). 배포 중 옛 코드와 새 스키마가 함께 도는 구간을 위해 남긴다';

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

-- 14인자 본체의 권한은 030 에서 준 것이 create or replace 로도 유지되지만,
-- 기본값을 떼면서 다시 만든 것이므로 한 번 더 명시한다
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
