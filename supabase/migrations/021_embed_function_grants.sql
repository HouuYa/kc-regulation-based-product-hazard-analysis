-- =============================================================================
-- 임베딩 자동 배치 함수의 실행 권한 닫기 — 020 의 revoke 가 듣지 않았다
--
-- 무엇이 잘못됐나 (020 적용 직후 ACL 을 조회해 발견)
--   020 은 009 의 방식을 그대로 따라 이렇게 썼다.
--
--     revoke execute on function public.embed_tick() from anon, authenticated;
--
--   그런데 적용 후에도 anon 이 세 함수를 전부 실행할 수 있었다.
--
--     embed_tick    acl={=X/postgres,postgres=X/postgres,service_role=X/postgres}
--     get_codes     acl={postgres=X/postgres,service_role=X/postgres}
--
--   앞머리의 `=X/postgres` 가 범인이다. 수령자 이름이 비어 있는 항목은 PUBLIC 을
--   뜻하고, 이것은 PostgreSQL 이 모든 새 함수에 기본으로 주는 권한이다.
--   anon·authenticated 는 PUBLIC 을 통해 실행 권한을 물려받으므로,
--   그 둘의 이름을 지워 봐야 통로가 그대로 열려 있다.
--
--   009 가 "앞으로 만들어지는 함수도 기본으로 열리지 않게 한다"며 걸어 둔
--   default privileges 도 anon·authenticated 만 막고 PUBLIC 은 놓쳤다. 그래서
--   009 이후에 만든 함수는 전부 이 구멍에 빠진다 — 020 이 첫 사례다.
--   (007 은 clause_hybrid_search 를 `from public` 으로 지워 무사했다. 두 파일이
--    서로 다른 방식을 쓰고 있었고, 그 차이가 여태 드러나지 않았을 뿐이다.)
--
-- 확인 방법
--   select p.proname, p.proacl::text,
--          has_function_privilege('anon', p.oid, 'EXECUTE')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public';
-- =============================================================================

revoke execute on function public.embed_collect()     from public;
revoke execute on function public.embed_dispatch(int) from public;
revoke execute on function public.embed_tick()        from public;

-- 009 의 마지막 줄이 하려던 일을 마저 한다. 이것이 없으면 다음에 만드는 함수도
-- 같은 구멍에 빠지고, 그때도 ACL 을 직접 들여다보기 전에는 알 수 없다.
--
-- 주의: 앞으로 public 스키마의 새 함수는 postgres·service_role 만 실행할 수 있다.
-- 언젠가 외부 이용 시스템에 조회 함수를 열어 줄 때는(009 가 말한 "Recall Hub 등")
-- 그 함수에만 명시적으로 grant 해야 한다.
alter default privileges in schema public revoke execute on functions from public;
