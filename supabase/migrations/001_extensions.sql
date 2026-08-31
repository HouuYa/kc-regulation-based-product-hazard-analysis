-- =============================================================================
-- 확장 기능
--
-- pgroonga 가 이 마이그레이션의 진짜 목적이다.
-- 설계문서 §5.3: PostgreSQL 기본 전문검색(to_tsvector)은 알파벳·숫자 기반 언어를
-- 전제하므로 한국어에는 한계가 있다. 조사가 붙어 "전도가/전도를/전도됨"이 서로
-- 다른 단어로 취급되어 키워드 갈래가 조용히 0건을 반환한다.
--
-- 결정항목 7 — "PGroonga 활성화 가능 여부"의 답을 이 파일이 실행되는 순간 얻는다.
-- 실패하면 키워드 갈래를 keywords[] 배열 연산 + pg_trgm 으로 구성해야 한다(§5.3 방안 B·C).
-- =============================================================================

-- 의미 검색용 벡터 (설계문서 §5.1 ③ 의미 매칭)
create extension if not exists vector with schema extensions;

-- 한국어 전문검색 (설계문서 §5.1 ② 키워드 매칭)
create extension if not exists pgroonga with schema extensions;

-- 오탈자 대비 보조 수단 (§5.3 방안 B). PGroonga 가 안 될 때의 폴백이기도 하다
create extension if not exists pg_trgm with schema extensions;
