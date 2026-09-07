-- =============================================================================
-- AI 호출 기록 — 어디서 · 어떤 모델로 · 얼마나 썼나
--
-- 무엇이 없었나 (2026-09-07)
--   토큰 수는 호출마다 계산해 돌려주고 있었는데(CallUsage) 어디에도 저장하지
--   않았다. 그래서 "이번 달 AI 에 얼마 썼나", "어느 단계가 제일 비싼가" 를
--   물으면 답할 자료가 아예 없었다. 태깅·재채점처럼 묶음으로 도는 작업은
--   한 번에 수백 번씩 부르는데도 그렇다.
--
-- 왜 표로 남기나
--   1) 비용을 보려면 이력이 있어야 한다. 지금 값만 보여 주는 화면으로는
--      "지난주보다 늘었나"를 알 수 없다.
--   2) 어느 단계가 비싼지 알아야 고칠 곳을 정한다. 실제로 적용범위 의미검색이
--      저장된 임베딩을 안 쓰고 매번 다시 만들고 있었는데(051 앞선 라운드),
--      이런 낭비는 기록이 없으면 드러나지 않는다.
--
-- 단가는 여기 두지 않는다
--   모델 단가는 바뀌고, 우리가 아는 값이 최신이라는 보장이 없다. 그래서 이 표에는
--   **실제로 쓴 토큰 수만** 남기고, 돈으로 환산하는 것은 코드의 단가표
--   (src/lib/llm/pricing.ts)가 맡는다. 단가가 등록되지 않은 모델은 화면에서
--   "단가 미등록"으로 표시하고 0 으로 세지 않는다 — 모르는 것을 0 으로 적으면
--   비용이 적어 보인다.
--
-- 실패도 남긴다
--   실패한 호출도 토큰을 쓴다(입력은 이미 보냈다). 성공만 세면 실제 지출과
--   어긋난다.
-- =============================================================================

create table if not exists public.llm_call (
  id               bigint generated always as identity primary key,
  called_at        timestamptz not null default now(),

  -- 어디서 불렀나. 화면이 이 값으로 묶어 보여 준다
  purpose          text not null,
  model            text not null,

  input_tokens     integer not null default 0,
  output_tokens    integer not null default 0,
  -- 추론 모델이 속으로 쓴 토큰. 출력 토큰에 포함돼 청구되므로 따로 본다
  reasoning_tokens integer not null default 0,

  -- 임베딩처럼 한 번에 여러 건을 보내는 호출은 몇 건이었는지 남긴다
  item_count       integer not null default 1,

  ok               boolean not null default true,
  error            text,

  -- 어느 사건·기준을 처리하다 부른 것인가. 없을 수도 있다
  case_id          bigint,
  standard_id      bigint
);

comment on table public.llm_call is
  'AI 호출 한 건의 기록. 토큰만 남기고 돈 환산은 코드의 단가표가 한다(052)';
comment on column public.llm_call.purpose is
  '부른 자리. 예: scope_semantic · scope_filter · rerank · tagging · hyde · gpc_verify · alias · taxonomy_link · embedding';
comment on column public.llm_call.reasoning_tokens is
  '추론 토큰. output_tokens 에 포함돼 청구되므로 따로 더하지 않는다';

create index if not exists llm_call_called_at_idx on public.llm_call (called_at desc);
create index if not exists llm_call_purpose_idx   on public.llm_call (purpose, called_at desc);

alter table public.llm_call enable row level security;
-- 서버(서비스 롤)만 쓴다. 브라우저에서 직접 읽을 일이 없다
revoke all on table public.llm_call from anon, authenticated;
