-- =============================================================================
-- 하이브리드 검색 — 세 갈래 + 순위 합산 (설계문서 §5.4, §5.5)
--
-- 왜 DB 함수 하나로 만드는가 (§5.5)
--   - 세 번 왕복하지 않고 DB 안에서 한 번에 계산 → 빠름
--   - 매칭 규칙이 한 곳에 모여 있어 감사·수정이 쉬움
--   - n8n 을 도입하더라도 RPC 한 번만 호출하면 됨
--
-- 왜 점수를 그냥 더하지 않는가 (§5.4)
--   갈래마다 점수의 단위가 다르다. 의미 검색은 0~1 유사도, 키워드 검색은 별도 척도다.
--   그대로 더하면 후하게 주는 갈래가 결과를 지배한다. 그래서 등수를 점수로 바꿔
--   더한다 — RRF(Reciprocal Rank Fusion), 점수 = Σ 1/(k + 그 갈래에서의 등수).
--   k=60 은 1등과 2등의 차이를 지나치게 벌리지 않기 위한 관행적 완충값이다.
--
-- 본 체계의 변형 — 코드 일치에 가산점 (§5.4)
--   순수 RRF 는 세 갈래를 동등하게 보지만, 코드 일치만이 통계 집계와 근거 제시에
--   쓸 수 있는 갈래이므로 우대한다. 가중치는 하드코딩하지 않고 인자로 받는다
--   (결정항목 10 — "0단계 실측 후 결정, 하드코딩하지 말고 설정값으로").
--
-- 갈래 스위치(p_use_*)가 있는 이유 (§5.8, §9)
--   0단계의 목적은 §5.8 비교표를 채우는 것이다. 갈래를 하나씩 켜며 재현율·오탐률을
--   재야 하는데, 스위치가 없으면 "코드만" 행을 측정할 방법이 없다.
--   "처음부터 전부 켜면 무엇이 효과를 냈는지 알 수 없다."
--
-- 주의 (§5.5)
--   참고 자료의 예시는 to_tsquery('english', ...) 를 쓴다. 한국어에는 그대로 쓸 수
--   없으므로 PGroonga 연산자로 바꿨다. 그대로 복사하면 키워드 갈래가 조용히 0건을
--   반환한다.
--
-- search_path 를 비우고 연산자를 스키마까지 적은 이유
--   security definer 함수에서 검색 경로 조작을 막기 위함이다. 대신 vector 의 <=> 와
--   PGroonga 의 &@~ 가 pg_catalog 에 없으므로 OPERATOR(extensions....) 로 적는다.
-- =============================================================================

create or replace function public.clause_hybrid_search(
  p_query_text       text,
  p_query_keywords   text[],
  p_query_embedding  extensions.vector(1536),
  p_hf_codes         text[],
  p_dt_codes         text[],
  p_standard_ids     bigint[] default null,
  p_match_count      int     default 20,
  -- §5.8 비교표를 위한 갈래 스위치
  p_use_code         boolean default true,
  p_use_keyword      boolean default true,
  p_use_vector       boolean default true,
  -- 융합 파라미터 (결정항목 10)
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
-- security invoker 로 둔다.
--   이 함수는 서버(DB 소유자 또는 service_role)만 호출하고, 두 역할 모두 RLS 를
--   우회하므로 definer 로 권한을 올릴 이유가 없다. 권한 오류를 definer 로 덮는 것은
--   원인을 고치지 않고 접근 통제를 없애는 일이다.
security invoker
set search_path = ''
as $$
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
$$;

comment on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric
) is
  '세 갈래 검색 + RRF 융합 + 코드 가산. 갈래 스위치로 §5.8 비교표를 채운다(5.4·5.5)';

-- 서버만 호출한다. 프론트엔드는 API 를 거친다(§1.3.3).
-- PUBLIC 부터 회수하는 이유: 새 함수의 EXECUTE 는 PUBLIC 에 자동으로 붙고
-- anon·authenticated 가 이를 상속하므로, anon 만 회수해서는 실제로 닫히지 않는다.
revoke execute on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric
) from public;

grant execute on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric
) to service_role;
