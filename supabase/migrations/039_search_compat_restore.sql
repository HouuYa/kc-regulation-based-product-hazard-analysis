-- =============================================================================
-- 13인자 호환 함수를 되살리고, 다시 사라지지 않게 순서를 정한다
--
-- 무엇이 일어났나 (038 을 넣고 확인하다 발견)
--   032 가 만든 13인자 호환 함수가 없어져 있었다. 038 이 지운 것이 아니다 —
--   038 의 drop 은 14인자 시그니처만 가리킨다.
--
--   원인은 마이그레이션 순서다. 030 의 첫머리에 이 문장이 있다.
--
--     drop function if exists public.clause_hybrid_search(
--       text, text[], extensions.vector, ..., numeric, numeric);   -- 13인자
--
--   030 을 쓸 당시에는 그것이 옛 함수를 치우는 올바른 문장이었다. 그런데 032 가
--   같은 13인자 시그니처로 **호환 함수**를 새로 만들면서, 030 의 그 줄은 이제
--   "호환 함수를 지우는 줄"이 됐다. 파일 번호 순서상 030 이 032 보다 먼저 돌므로,
--   마이그레이션을 처음부터 다시 적용하면 032 가 만든 것을 030 이 지우고,
--   그 뒤 032 가 다시 만든다 — 여기까지는 결과가 같다.
--
--   문제는 일부만 다시 도는 경우다. 실제로 db:push 가 파일 내용이 바뀐 것들만
--   골라 다시 돌렸을 때 030 은 재적용되고 032 는 건너뛰어져, 호환 함수만 사라졌다.
--
-- 왜 이것이 조용한 사고인가
--   호환 함수가 없어도 새 코드는 14인자로 부르므로 잘 돈다. 옛 코드가 도는
--   배포 구간에서만 죽는다. 즉 평소에는 아무 증상이 없다가 배포하는 순간
--   분석이 멈춘다 — 032 가 막으려던 바로 그 사고가 그대로 되돌아온다.
--
-- 어떻게 막는가
--   호환 함수를 만드는 일을 **가장 큰 번호의 파일**에 둔다. 그러면 앞 번호의
--   어떤 drop 이 돌더라도 마지막에 다시 만들어진다.
--
--   앞으로 clause_hybrid_search 본체를 바꾸는 마이그레이션을 추가할 때는,
--   그보다 큰 번호로 이 파일의 내용을 다시 한 번 넣어야 한다. 본체를 지웠다
--   다시 만드는 마이그레이션은 호환 함수를 건드리지 않지만, 030 처럼 13인자를
--   지우는 문장이 어딘가에 남아 있는 한 순서가 결과를 바꾼다.
-- =============================================================================

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
  -- 검수 확정 태그만 쓰는 스위치는 끈 상태로 넘긴다. 030 이 정한 기본값과 같고
  -- 007 이후 줄곧 해 오던 동작과도 같다 — 옛 코드는 예전과 똑같이 동작한다
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
  '13인자 호환 진입점(032·039). 배포 중 옛 코드와 새 스키마가 함께 도는 구간을 위해 남긴다. '
  '이 파일은 마이그레이션 번호가 가장 커야 한다 — 앞 번호의 drop 이 이것을 지우기 때문이다';

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
