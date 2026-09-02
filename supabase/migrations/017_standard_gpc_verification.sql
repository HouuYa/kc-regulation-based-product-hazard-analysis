-- =============================================================================
-- KC안전기준(standard) GPC 매칭 — LLM 검증 레이어 추가 (라운드 11)
--
-- 라운드 10 실측: 임베딩 top-1을 그대로 확정하면 5건 중 3건이 오답이었다.
-- top-20까지 넓혀 다시 보니 서로 다른 두 문제가 섞여 있었다.
--   ① 순위만 밀린 경우 — 정답이 후보 안에 있는데 1위가 아니다
--      (예: "어린이용 물놀이기구"는 11위 "목욕/수영용 물놀이완구"가 정답에
--      가까운데 1~3위는 전부 무관한 "요실금 제품"이었다).
--   ② 애초에 후보 안에 정답이 없는 경우 — GPC 카탈로그에 대응 브릭이
--      없거나, KC기준 자체가 여러 브릭에 걸친 우산 카테고리다
--      (예: 예초기 보호덮개, 가죽제품 — 정의 조항을 직접 읽어도 "가죽"이라는
--      단어 자체가 없고 나이대만 규정한다).
-- ①은 LLM이 후보를 다시 읽고 고르면 고칠 수 있지만, ②는 후보가 없다고
-- 정직하게 답하는 것(NONE)이 맞는 답이지 top-1을 억지로 확정하는 것은
-- 오답이다. 그래서 임베딩 top-1을 그대로 저장하지 않고, LLM이 후보 목록
-- 안에서(enum 제약, tagging.ts와 같은 원리) 실제로 맞는지 검증하게 한다.
--
-- gpc_brick_code(임베딩 1위, 미검증)는 의미를 바꾸지 않고 그대로 둔다 —
-- case_event.gpc_brick_code 와 같은 의미를 유지해야 두 테이블의 같은
-- 이름 컬럼이 헷갈리지 않는다. 검증을 거친 답은 별도 컬럼에 둔다.
-- =============================================================================

alter table public.standard
  add column if not exists gpc_verified_brick_code text,
  add column if not exists gpc_verification jsonb;

comment on column public.standard.gpc_verified_brick_code is
  'LLM이 gpc_candidates 후보 중에서 실제로 맞는지 검증한 최종 선택(src/lib/gpc/verify.ts). NULL이면 후보 중 맞는 게 없다고 판단(NONE)했거나 아직 검증 전이다. 여전히 담당자 검토가 필요한 후보이지 확정값이 아니다';
comment on column public.standard.gpc_verification is
  'LLM 검증 근거 — {confidenceScore, reasoning, candidateCount, model}. gpc_brick_code(임베딩 1위, 미검증)와 달리 사람이 읽고 판단할 수 있는 이유가 붙는다';
