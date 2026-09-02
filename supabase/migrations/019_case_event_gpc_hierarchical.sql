-- =============================================================================
-- 사고조사보고서(case_event) GPC 매칭 — standard와 동일한 계층 컬럼으로 확장
--
-- 라운드 12: 담당자가 "본 사항(라운드 11의 standard GPC 검증)은 사고조사
-- GPC 코드 부여에도 사용되는 로직이지요?"라고 물어서 확인해 보니 아니었다 —
-- case_event 쪽(scripts/load-cases.ts processPhotos)은 여전히 임베딩 top-1을
-- 검증 없이 확정하고 있었다. "최대한 공유하도록 리팩터링"해 달라는 요청에
-- 따라 조회+검증 오케스트레이션은 src/lib/gpc/assign.ts(findAndVerifyGpc)로
-- 뽑아 공유하고, 저장 구조도 018_standard_gpc_hierarchical.sql과 완전히
-- 같은 컬럼 세트로 맞춘다 — standard 자신이 017(단일 컬럼)에서 018(계층
-- 전체)로 이미 한 번 버린 방식을 case_event에서 반복할 이유가 없다는 게
-- 담당자 판단이었다(질문으로 확인).
--
-- gpc_brick_code(004_case_event.sql부터 있던 컬럼, 임베딩 1위·미검증)는
-- 의미를 바꾸지 않는다 — standard.gpc_brick_code와 같은 뜻을 유지한다.
-- gpc_candidates는 지금까지 raw_fields->'gpc_candidates'에 들어 있던 것을
-- 전용 컬럼으로 옮긴다(기존 값은 아래에서 1회 백필). raw_fields의 그 키는
-- 지우지 않는다 — 과거 흔적으로 남겨 둬도 무해하다.
-- =============================================================================

alter table public.case_event
  add column if not exists gpc_candidates jsonb,
  add column if not exists gpc_verification jsonb,
  add column if not exists gpc_verified_level text
    check (gpc_verified_level in ('BRICK', 'CLASS', 'FAMILY', 'SEGMENT', 'NONE')),
  add column if not exists gpc_verified_segment_code  text,
  add column if not exists gpc_verified_segment_title text,
  add column if not exists gpc_verified_family_code   text,
  add column if not exists gpc_verified_family_title  text,
  add column if not exists gpc_verified_class_code    text,
  add column if not exists gpc_verified_class_title   text,
  add column if not exists gpc_verified_brick_code    text,
  add column if not exists gpc_verified_brick_title   text;

comment on column public.case_event.gpc_candidates is
  'findGpcCandidates() 원 결과 배열(순위·유사도 포함). standard.gpc_candidates 와 같은 방식';
comment on column public.case_event.gpc_verification is
  'LLM 검증 근거 — {level, confidenceScore, reasoning, candidateCount, model}. standard.gpc_verification 과 같은 방식';
comment on column public.case_event.gpc_verified_level is
  'LLM이 검증한 매칭 계층 — BRICK/CLASS/FAMILY/SEGMENT/NONE(src/lib/gpc/verify.ts). NONE이면 아래 코드 컬럼 전부 NULL. 확정값이 아니라 담당자 검토용 후보다';

-- 기존 raw_fields.gpc_candidates 를 새 전용 컬럼으로 1회 백필한다.
-- 과거에 blind top-1 방식으로 이미 처리된 사건들이라 검증 컬럼(gpc_verified_*,
-- gpc_verification)은 채울 근거가 없으므로 NULL 로 남긴다 — 재검증하려면
-- npm run cases:load -- --force --only "<파일명>" 으로 다시 돌려야 한다.
update public.case_event
set gpc_candidates = raw_fields->'gpc_candidates'
where raw_fields ? 'gpc_candidates' and gpc_candidates is null;
