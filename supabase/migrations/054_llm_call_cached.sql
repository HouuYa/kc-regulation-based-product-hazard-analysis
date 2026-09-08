-- =============================================================================
-- 054 캐시된 입력 토큰을 따로 센다
--
-- 왜 필요한가
--   OpenAI 단가표(developers.openai.com/api/docs/pricing, 2026-09-08 확인)에서
--   캐시된 입력은 일반 입력의 10% 다.
--
--     gpt-5.6-terra  입력 $2.00 / 캐시된 입력 $0.20   (100만 토큰당, 짧은 문맥)
--     gpt-5.6-luna   입력 $0.20 / 캐시된 입력 $0.02
--
--   이 체계는 입력 토큰이 출력의 20배가 넘는다(052 기록). 같은 프롬프트 앞부분을
--   반복해 보내는 구조라서 — 후보 기준의 적용범위 원문, 코드북 enum 목록이
--   호출마다 그대로 다시 나간다 — 캐시 적중이 실제로 일어난다. 그것을 세지 않으면
--   화면의 금액이 실제 청구보다 부풀려지고, "캐시가 듣고 있나"를 볼 수도 없다.
--
--   입력 토큰(input_tokens)에는 캐시된 것이 이미 포함돼 있다. 그래서 빼서 더하지
--   않고, 금액을 계산할 때 (input - cached) 와 cached 를 다른 단가로 매긴다.
-- =============================================================================

alter table public.llm_call
  add column if not exists cached_tokens integer not null default 0;

comment on column public.llm_call.cached_tokens is
  '입력 토큰 중 캐시 적중분. input_tokens 에 포함된 값이며 단가가 1/10 이다(054)';

-- 모델별 집계를 화면이 자주 부른다. 용도별 색인은 052 에 이미 있다
create index if not exists llm_call_model_idx on public.llm_call (model, called_at desc);
