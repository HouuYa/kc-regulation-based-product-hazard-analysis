-- =============================================================================
-- KC안전기준(standard)에 GPC(GS1 국제 품목분류) 코드 부여 — 착수(1단계, 소량 시험용)
--
-- case_event 쪽 GPC 연동(015 이전, src/lib/gpc/lookup.ts)과 같은 패턴을 그대로
-- 따른다. 대상을 public.standard 로 잡은 이유: GPC 는 "제품이 무엇인가"를
-- 분류하는 것이고, public.standard.item_name 이 문서 1건당 그 제품명을 이미
-- 갖고 있다(예: "유아용 캐리어", "가습기"). clause 는 기준 문서 안의 개별 요건
-- 행이라 제품 단위가 아니므로 대상이 아니다.
--
-- 이 마이그레이션은 컬럼만 만든다. 전량 배치(76건 is_current 표준)는 이번
-- 라운드에서 돌리지 않는다 — LLM 임베딩 호출 비용이 들고, item_name 이 null 인
-- 표준(KC 60335-2-xx 류 베이스표준, display_name 만 있고 품목명이 없음)은
-- 애초에 이 방식으로 조회할 입력이 없어 별도 검토가 필요하다. 소수 건만
-- 시험 스크립트로 돌려 패턴이 이 데이터에서도 통하는지만 확인한다
-- (구현이력.md 이번 라운드 항목 참고).
-- =============================================================================

alter table public.standard
  add column if not exists gpc_brick_code text,
  add column if not exists gpc_candidates jsonb;

comment on column public.standard.gpc_brick_code is
  'GPC 브릭 코드 1위 (src/lib/gpc/lookup.ts). case_event.gpc_brick_code 와 같은 방식 — 순위 전체는 gpc_candidates 에 있다';
comment on column public.standard.gpc_candidates is
  'findGpcCandidates() 원 결과 배열(순위·유사도 포함). null = 아직 조회 안 함';
