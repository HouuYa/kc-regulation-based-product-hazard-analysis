-- =============================================================================
-- 용어 사전에 LLM 제안 출처를 더한다
--
-- 왜 필요한가 (2026-09-05 실측)
--   사고보고서 71건 중 13건이 적용 기준을 못 찾아 분석 자체가 시작되지 않는다.
--   그중 7건(54%)이 등기구 하나다 — LED등기구 5건, 할로겐등기구 2건.
--
--   기준이 없어서가 아니다. KC 60598-2-1·2-2·2-4 가 이미 적재돼 있다.
--   그 세 기준에 적용범위 원문(scope_text)도 품목명(item_name)도 비어 있어서
--   품목 확정의 두 경로가 모두 막힌 것이다. 자료 구멍이지 알고리즘 문제가 아니다.
--
-- 왜 SEMANTIC 을 재사용하지 않는가
--   의미 검색(임베딩 최근접)과 LLM 판단은 근거의 성격이 다르다. 의미 검색은 같은
--   질의에 늘 같은 답을 주지만 LLM 은 모델과 프롬프트에 따라 달라진다. 한 칸에
--   섞어 두면 나중에 "이 대응은 무엇이 정했는가"를 되짚을 수 없다.
--
-- 바로 쓰이지 않는다
--   review_status 기본값이 auto_unreviewed 이므로 담당자가 /terms 에서 확정해야
--   검색에 반영된다. 품목이 틀리면 엉뚱한 기준의 시험이 나오는데, 그것은 조용히
--   틀리는 종류의 고장이라 사람이 먼저 봐야 한다.
-- =============================================================================

alter table public.scope_term drop constraint if exists scope_term_source_check;

alter table public.scope_term
  add constraint scope_term_source_check
  check (source in ('EXPERT', 'SEMANTIC', 'LLM'));

comment on column public.scope_term.source is
  'EXPERT 담당자가 정함 / SEMANTIC 의미 검색이 찾음 / LLM 이 제안함(확정 전에는 검색에 쓰이지 않는다)';
