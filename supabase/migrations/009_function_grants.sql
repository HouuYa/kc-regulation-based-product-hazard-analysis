-- =============================================================================
-- 함수 실행 권한 정리 — 최소 권한 원칙
--
-- 왜 별도 마이그레이션인가 (실측으로 알아낸 것)
--   Supabase 는 public 스키마의 새 함수에 EXECUTE 를 anon·authenticated 에게
--   기본 권한(default privileges)으로 자동 부여한다.
--   PUBLIC 상속이 아니라 명시적 ACL 항목이므로 `revoke ... from public` 으로는
--   지워지지 않는다. 실제 ACL 을 조회해 보고서야 확인했다.
--
--     proacl = {postgres=X/postgres, anon=X/postgres,
--               authenticated=X/postgres, service_role=X/postgres}
--
--   그 결과 clause_hybrid_search 까지 anon 이 호출할 수 있는 상태였다.
--   security invoker + RLS 덕에 행은 못 보지만, 열어 둘 이유가 없는 통로다.
--
-- 방침
--   0단계에는 외부 이용 시스템도 로그인 사용자도 없다. 전부 서버 전용으로 닫는다.
--   Recall Hub 등이 실제로 코드북을 참조하게 되면 그때 조회 함수 5종에만
--   anon 실행 권한을 다시 연다(설계문서 2.4.3 "조회 전용 키로 분리").
--
-- 확인 방법
--   select p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public';
-- =============================================================================

revoke execute on function public.get_current_version()                   from anon, authenticated;
revoke execute on function public.get_codes(text, text, boolean)          from anon, authenticated;
revoke execute on function public.get_code_detail(text, text)             from anon, authenticated;
revoke execute on function public.resolve_code(text, text)                from anon, authenticated;
revoke execute on function public.validate_code_set(text[], text[], text) from anon, authenticated;
revoke execute on function public.diff_versions(text, text)               from anon, authenticated;
revoke execute on function public.resolve_version_id(text)                from anon, authenticated;

revoke execute on function public.clause_hybrid_search(
  text, text[], extensions.vector, text[], text[], bigint[], int,
  boolean, boolean, boolean, int, numeric, numeric
) from anon, authenticated;

-- 앞으로 이 스키마에 만들어지는 함수도 기본으로 열리지 않게 한다.
-- 이것이 없으면 다음 마이그레이션에서 같은 실수가 조용히 반복된다.
alter default privileges in schema public revoke execute on functions from anon, authenticated;
