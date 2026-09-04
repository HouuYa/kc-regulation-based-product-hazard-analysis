-- =============================================================================
-- 검색에 쓸 태그를 검수 확정분으로 좁힐 수 있게 한다 — 스위치로 둔다
--
-- 무엇이 어긋나 있었나 (02_1차 보완 및 구현 설계서 §3.2)
--   007 의 코드 갈래는 "반려되지 않은 태그"를 전부 쓴다.
--
--     and t.review_status <> 'rejected'
--
--   그런데 clause_tag·case_tag 의 기본값은 auto_unreviewed 다(003·004). 즉 사람이
--   한 번도 보지 않은 자동 태그가 match_path='CODE' 로 표시되어, 검수를 거친 태그와
--   같은 자격으로 담당자에게 제시된다. 설계문서가 약속한 "검수 확정 태깅을 정식
--   근거로 사용"과 다르다.
--
--   화면이 아주 무방비였던 것은 아니다. match.ts 의 evidenceLevelOf() 가
--   승인 태그가 있을 때만 근거등급 A 를 주고 나머지는 B 로 내린다. 그러나 그것은
--   "표시를 달리하는 것"이지 "후보에서 빼는 것"이 아니다. 미검수 태그만으로도
--   코드 갈래에 오르고 가산점(p_w_code)을 받는다.
--
-- 왜 기본값을 바꾸지 않는가
--   지금 코드 근거의 몇 %가 미검수인지 아직 세어 보지 않았다. 그 숫자를 모르고
--   기본 동작을 바꾸면 담당자가 보던 결과가 하루아침에 달라진다. 그래서 스위치만
--   만들고 기본값은 false(기존 동작 그대로)로 둔다 — CLAUDE.md §6 의 방식대로
--   비교할 수 있는 구조를 만들어 두고 데이터로 판정한다.
--
--   세어 보는 조회문은 02 설계서 §3.2 에 실어 두었다.
--
-- 어떤 설정으로 돌렸는지 남긴다
--   match_run 에 컬럼을 하나 더한다. 갈래 스위치·가중치를 남기는 기존 관례와 같다.
--   남기지 않으면 나중에 두 결과를 비교할 때 무엇이 달랐는지 알 수 없다.
-- =============================================================================

-- 인자를 하나 더하므로 옛 시그니처를 먼저 지운다.
-- 새 인자에 기본값이 있어서, 둘을 함께 두면 13개로 부를 때 어느 쪽이 불릴지
-- 헷갈린다. 호출부는 src/lib/search/match.ts 한 곳뿐이라 같이 고치면 된다.
drop function if exists public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric
);

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
  p_w_code_partial   numeric default 0.2,
  -- 코드 갈래에 검수 확정 태그만 쓸 것인가 (030)
  --   false = 반려되지 않은 태그 전부 (007 이후의 기존 동작)
  --   true  = review_status='approved' 인 태그만
  p_require_approved_tags boolean default false
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
$$;

comment on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric, boolean
) is
  '세 갈래 검색 + RRF 융합 + 코드 가산. 갈래 스위치로 §5.8 비교표를 채운다(5.4·5.5). '
  '마지막 인자를 켜면 코드 갈래에 검수 확정 태그만 쓴다(030)';

-- 서버만 호출한다. 프론트엔드는 API 를 거친다(§1.3.3).
-- 009 가 alter default privileges 를 걸어 두어 새 함수가 anon·authenticated 에게
-- 자동으로 열리지는 않지만, 명시적으로 한 번 더 닫는다 — 실제로 이 실수가 있었다.
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

-- -----------------------------------------------------------------------------
-- 어떤 설정으로 돌린 결과인지 남긴다
--
-- match_run 은 이미 갈래 스위치와 융합 가중치를 남기고 있다. 같은 이유로 이 값도
-- 남긴다 — 남기지 않으면 나중에 두 결과를 비교할 때 무엇이 달랐는지 알 수 없다.
-- -----------------------------------------------------------------------------
alter table public.match_run
  add column if not exists require_approved_tags boolean not null default false;

comment on column public.match_run.require_approved_tags is
  '코드 갈래에 검수 확정 태그만 썼는가(030). 기존 실행은 전부 false 로 남는다';
