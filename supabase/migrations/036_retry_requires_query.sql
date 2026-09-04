-- =============================================================================
-- 재시도가 인자 없이 나가지 않게 막는다 — 옛 기록에는 인자가 없다
--
-- 무엇을 놓쳤나 (035 를 넣고 바로 확인하다 발견)
--   035 가 job_run.query 컬럼을 새로 만들었으므로, 그 전에 쌓인 기록 257건에는
--   인자가 없다(null). retry_failed_jobs() 가 그런 행을 집으면
--   run_job_at(job, null) 이 되고, URL 에서 물음표 뒤가 통째로 빠진다.
--
--     coalesce('?' || null, '')  →  ''
--
--   그러면 라우트는 기본값으로 돈다 — recalls-fetch 의 기본 limit 은 20 이다.
--   034 에서 3건으로 낮춘 이유가 30초 제한이었는데, 재시도가 20건을 요청하면
--   반드시 시간 초과가 난다. 실패를 고치려고 만든 장치가 더 큰 실패를 만드는 셈이다.
--
--   실패한 옛 기록은 이미 다음 순환이 같은 구간을 다시 훑으므로, 굳이 지금
--   되살릴 이유도 없다.
--
-- 고치는 방법
--   인자를 아는 실행만 다시 보낸다. 035 이후에 생긴 기록은 전부 인자를 갖고 있다.
-- =============================================================================

create or replace function public.retry_failed_jobs()
returns text
language plpgsql
security definer
set search_path = ''
as $retry$
declare
  c_max_attempt constant int := 3;   -- 최초 1 + 재시도 2
  r     record;
  v_n   int := 0;
begin
  for r in
    select j.id, j.job, j.query, j.attempt
    from public.job_run j
    where j.settled_at is not null
      and j.settled_at > now() - interval '30 minutes'
      -- 실패로 보는 것: 5xx, 그리고 응답이 아예 오지 않은 것(status_code = 0)
      and (j.status_code >= 500 or j.status_code = 0)
      and j.attempt < c_max_attempt
      -- 인자를 모르면 다시 보내지 않는다. 인자 없이 보내면 라우트가 기본값으로
      -- 돌아 034 가 정한 구간 크기를 무시하게 된다(036)
      and j.query is not null
      -- 이미 이 실행을 다시 시도해 두었으면 또 하지 않는다
      and not exists (
        select 1 from public.job_run k where k.retry_of = j.id
      )
      -- 같은 구간이 그 사이 다른 실행에서 성공했으면 다시 하지 않는다
      and not exists (
        select 1 from public.job_run k
        where k.job = j.job
          and k.query is not distinct from j.query
          and k.status_code = 200
          and k.started_at > j.started_at
      )
    order by j.settled_at
    limit 5
  loop
    declare
      v_req bigint;
    begin
      v_req := public.run_job_at(r.job, r.query);
      update public.job_run
      set attempt = r.attempt + 1, retry_of = r.id
      where request_id = v_req;
      v_n := v_n + 1;
    exception when others then
      -- 한 건이 실패해도 나머지는 계속한다. 비밀값이 빠졌을 때가 이 경우다
      raise warning '재시도 실패 (%): %', r.job, sqlerrm;
    end;
  end loop;

  return format('실패한 작업 %s건 다시 보냄', v_n);
end;
$retry$;

revoke execute on function public.retry_failed_jobs() from public;
revoke execute on function public.retry_failed_jobs() from anon, authenticated;
