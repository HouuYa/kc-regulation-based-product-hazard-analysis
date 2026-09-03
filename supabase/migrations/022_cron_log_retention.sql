-- =============================================================================
-- cron 실행 기록 정리 — 무한히 쌓이지 않게 한다
--
-- 왜 필요한가 (라운드 17 비용 계산에서 나온 항목)
--   020 이 1분 주기 작업을 걸면서 pg_cron 이 실행할 때마다 cron.job_run_details 에
--   기록을 한 줄씩 남긴다. 실측으로 1건당 약 128바이트이므로
--
--     하루 1,440건 = 180 KB
--     1년          = 64 MB
--
--   지금 규모에서는 문제가 아니지만, 아무도 지우지 않으면 영원히 늘어난다.
--   그리고 이 표는 우리가 만든 것이 아니라 pg_cron 이 관리하는 표라서, 용량이
--   문제가 될 때쯤이면 "이게 왜 이렇게 큰가"를 되짚기 어렵다. 지금 정리 규칙을
--   같이 넣어 두는 편이 낫다.
--
-- 30일을 남기는 이유
--   이 기록의 쓸모는 "최근에 배치가 제대로 돌았는가"를 되짚는 것 하나다.
--   한 달 전에 실패한 tick 을 들여다볼 일은 없다 — 그때 실패했다면 그 결과가
--   embed_queue 에 failed/parked 로 남아 있고, 그쪽이 진짜 장부다.
--   30일이면 4만 3천 건 · 5.5 MB 안팎에서 평형을 이룬다.
--
-- 지울 수 있는지는 실측으로 확인했다
--   cron.job_run_details 의 소유자는 supabase_admin 이라 지우지 못할 수도 있었는데,
--   트랜잭션 안에서 delete 를 시험해 보니 통과했다(pg_cron 은 작업을 등록한
--   사용자에게 자기 기록에 대한 권한을 준다).
-- =============================================================================

create or replace function public.cron_log_prune(p_keep_days int default 30)
returns int
language plpgsql
security definer
set search_path = ''
as $prune$
declare
  v_deleted int;
begin
  delete from cron.job_run_details
  where end_time < now() - make_interval(days => p_keep_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$prune$;

comment on function public.cron_log_prune(int) is
  'cron 실행 기록을 지정 일수만 남기고 지운다. 매일 1회 cron-log-prune 작업이 부른다';

-- 020·021 에서 배운 대로 PUBLIC 까지 닫는다.
-- (revoke ... from anon, authenticated 만으로는 PUBLIC 상속이 남는다 — 021 주석 참고)
revoke execute on function public.cron_log_prune(int) from public;

-- -----------------------------------------------------------------------------
-- 하루 1회.
--
-- pg_cron 은 DB 시간대(UTC)로 해석하므로 18:20 UTC = 03:20 KST 다.
-- 새벽에 두는 이유는 습관이지 성능 때문이 아니다 — 4만 건 삭제는 순식간이다.
-- -----------------------------------------------------------------------------
select cron.unschedule('cron-log-prune')
where exists (select 1 from cron.job where jobname = 'cron-log-prune');

select cron.schedule('cron-log-prune', '20 18 * * *', $job$select public.cron_log_prune()$job$);
