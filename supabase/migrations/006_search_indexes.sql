-- =============================================================================
-- 검색 인덱스
--
-- 근거: 설계문서 §5.2.4, §5.3, §9
--
-- 색인 대상이 body 가 아니라 search_text 인 것이 핵심이다.
-- §5.2.4: "임베딩에만 맥락을 붙이고 키워드 색인에는 안 붙이는 것은 절반만 하는 것" —
-- Anthropic 실험에서 맥락 결합을 임베딩에만 적용하면 검색 실패율 5.7%→3.7%,
-- 키워드 색인까지 적용하면 2.9% 까지 내려갔다. 그래서 PGroonga 인덱스도
-- 결합된 텍스트를 대상으로 만든다.
--
-- 벡터 인덱스(HNSW)는 만들지 않는다.
-- §9: "이 규모에서는 벡터 인덱스 없이 전체 스캔으로도 충분하다. 인덱스 튜닝은
-- 0단계에서 할 일이 아니다." 조항 13,501건 중 0단계 대상은 수백 건이다.
-- =============================================================================

-- 한국어 키워드 갈래 (§5.1 ②)
create index if not exists clause_search_text_pgroonga_idx
  on public.clause using pgroonga (search_text);

create index if not exists case_event_search_text_pgroonga_idx
  on public.case_event using pgroonga (search_text);

-- LLM 이 뽑은 용어 배열 (§5.3 방안 C — PGroonga 와 병행 권고)
-- 본문 검색은 담당자가 임의 용어로 찾을 때, 키워드 배열은 사고↔조항 자동 대조에 쓴다
create index if not exists clause_keywords_gin_idx
  on public.clause using gin (keywords);

create index if not exists case_event_keywords_gin_idx
  on public.case_event using gin (keywords);

-- 임베딩이 아직 없는 조항을 빠르게 골라내기 위한 부분 인덱스 (배치 재개용)
create index if not exists clause_embedding_missing_idx
  on public.clause (standard_id) where embedding is null;
