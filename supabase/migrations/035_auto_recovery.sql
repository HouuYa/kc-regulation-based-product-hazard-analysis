-- =============================================================================
-- 막힌 것을 스스로 다시 돌린다 — 알림만 보내고 손 놓던 자리를 메운다
--
-- 무엇이 없었나 (담당자 지적, 2026-09-04)
--   "대기열 확인 및 오류 재실행이 자동으로 돌아가야 하는 것 아닌가"
--
--   맞다. 지금까지 자동으로 도는 것은 세 가지뿐이었다.
--
--     embed_tick   1분  의미 검색 준비를 보내고 수거한다. 5회까지 재시도한다
--     ops_watch    5분  실패를 세어 텔레그램으로 알린다
--     정기 작업    2~5분  리콜 수집·기준 동기화
--
--   빠진 것은 "알린 다음"이다. 정기 작업이 실패하면 알림만 가고 아무도 다시
--   돌리지 않았다. 다음 차례가 올 때까지 그 구간은 그냥 비어 있었다.
--   임베딩이 5회를 채워 세워지면 사람이 화면에서 눌러야 풀렸고, 태깅 실패
--   조항(029)도 마찬가지였다.
--
--   실제로 이것이 비싸게 드러났다. recalls-fetch 가 52번 연속 실패하는 동안
--   자동으로 다시 시도한 적이 한 번도 없었고, 알림은 쌓이기만 해서 아무도
--   읽지 않게 됐다. 사람이 손으로 조사해야 원인이 나왔다.
--
-- 무엇을 더하는가
--   1) 실패한 정기 작업을 같은 인자로 다시 보낸다 (최대 2회)
--   2) 5회를 채워 세워 둔 임베딩을 하루 한 번 다시 대기열에 올린다
--   3) 태깅 실패로 넘긴 조항을 하루 한 번 다시 대상에 넣는다
--
-- 왜 즉시 재시도가 아니라 이렇게 나누는가
--   1) 은 대개 일시적(시간 초과·순간 장애)이라 곧바로 다시 하면 풀린다.
--   2) 3) 은 원인이 자료 자체일 가능성이 높다. 곧바로 반복하면 같은 실패를
--      분 단위로 되풀이하며 돈만 쓴다. 하루 한 번이면 "그 사이에 사람이 고쳤을
--      수도 있는" 간격이 되고, 안 고쳐졌으면 하루 한 번의 비용만 든다.
--
--   태깅 재시도는 비용이 든다(조항당 약 $0.0022). 담당자가 "전부 자동"을
--   선택했고, 실물 기준 하루 40건이면 약 $0.09 다. 다만 몇 번째 되돌림인지를
--   기록해 화면에서 볼 수 있게 한다 — 매일 같은 조항이 실패하고 있다면
--   그것은 자동화가 아니라 사람이 볼 일이다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 다시 보내려면 무엇을 어떤 인자로 보냈는지 알아야 한다
--
-- job_run 은 지금까지 작업 이름만 남겼다. 리콜 수집은 offset·limit 이 붙으므로
-- 이름만으로는 같은 구간을 다시 보낼 수 없다.
-- -----------------------------------------------------------------------------
alter table public.job_run
  add column if not exists query    text,
  add column if not exists attempt  int not null default 1,
  add column if not exists retry_of bigint references public.job_run(id);

comment on column public.job_run.query    is '주소 뒤에 붙였던 값(offset=…&limit=…). 재시도가 같은 구간을 다시 보내려면 필요하다';
comment on column public.job_run.attempt  is '이 구간에 대한 몇 번째 시도인가. 1 이 최초';
comment on column public.job_run.retry_of is '무엇을 다시 시도한 것인가. null 이면 정기 실행';

create index if not exists job_run_retry_idx on public.job_run (job, settled_at desc);

-- run_job_at 이 인자를 함께 남기도록 고친다
create or replace function public.run_job_at(p_job text, p_query text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $run_job_at$
declare
  v_token text;
  v_base  text;
  v_req   bigint;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'jobs_token';
  select decrypted_secret into v_base  from vault.decrypted_secrets where name = 'site_base_url';

  if v_token is null or v_base is null then
    raise exception '비밀값 보관함에 jobs_token 또는 site_base_url 이 없습니다. npm run ops:secret 을 실행하세요.';
  end if;

  select net.http_post(
    url     := rtrim(v_base, '/') || '/api/jobs/' || p_job || coalesce('?' || p_query, ''),
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_token),
    timeout_milliseconds := 60000
  ) into v_req;

  insert into public.job_run (job, request_id, query) values (p_job, v_req, p_query);
  return v_req;
end;
$run_job_at$;

revoke execute on function public.run_job_at(text, text) from public;
revoke execute on function public.run_job_at(text, text) from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1) 실패한 정기 작업을 같은 구간으로 다시 보낸다
--
-- 최대 2회까지만 한다. 계속 실패하는 것은 일시적 장애가 아니라 고장이고,
-- 무한히 다시 보내면 고장 위에 요청만 쌓는다 — recalls-fetch 가 52번 실패하는
-- 동안 5분마다 새 요청이 들어가던 것과 같은 모양이 된다.
--
-- 성공한 구간은 다시 보내지 않는다. 같은 구간을 두 번 처리해도 upsert 라
-- 결과는 같지만, 돈과 시간을 두 번 쓸 이유가 없다.
-- -----------------------------------------------------------------------------
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

comment on function public.retry_failed_jobs() is
  '최근 30분 안에 실패한 정기 작업을 같은 구간으로 다시 보낸다. 구간당 최대 3회';

revoke execute on function public.retry_failed_jobs() from public;
revoke execute on function public.retry_failed_jobs() from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2)·3) 하루 한 번, 세워 둔 것을 다시 대상에 넣는다
--
-- 몇 번째 되돌림인지 남긴다. 매일 같은 것이 실패하고 있다면 자동화가 아니라
-- 사람이 볼 일이므로, 그 사실이 화면에 드러나야 한다.
-- -----------------------------------------------------------------------------
create table if not exists public.recovery_log (
  id          bigint generated always as identity primary key,
  kind        text        not null check (kind in ('embedding', 'tagging')),
  affected    int         not null,
  ran_at      timestamptz not null default now()
);

comment on table public.recovery_log is
  '자동 복구가 무엇을 몇 건 되돌렸는가. 같은 건수가 매일 반복되면 자동으로 안 풀리는 것이다';

alter table public.recovery_log enable row level security;
revoke all on table public.recovery_log from anon, authenticated;

create or replace function public.auto_recover()
returns text
language plpgsql
security definer
set search_path = ''
as $recover$
declare
  v_emb int := 0;
  v_tag int := 0;
begin
  -- 세워 둔 임베딩을 대기열에서 지운다. embed_tick 은 "임베딩이 없고 문장이 있는"
  -- 행을 후보로 삼으므로, 막고 있던 대기열 행만 치우면 다음 차례에 다시 잡힌다
  delete from public.embed_queue
  where status = 'failed' and attempts >= 5;
  get diagnostics v_emb = row_count;

  if v_emb > 0 then
    insert into public.recovery_log (kind, affected) values ('embedding', v_emb);
  end if;

  -- 태깅 실패로 넘긴 조항을 다시 대상에 넣는다(029)
  select public.reset_tag_failures() into v_tag;

  if v_tag > 0 then
    insert into public.recovery_log (kind, affected) values ('tagging', v_tag);

    -- 같은 건수가 사흘 내리 반복되면 자동으로 풀리지 않는 것이다. 사람을 부른다
    if (select count(*) from (
          select affected from public.recovery_log
          where kind = 'tagging' order by ran_at desc limit 3) t
        where t.affected = v_tag) = 3 then
      perform public.ops_notify(
        '태깅 자동 복구가 반복됩니다',
        format(E'조항 %s건이 사흘 내리 같은 수로 되돌려지고 있습니다.\n자동 재시도로 풀리지 않는 문제입니다 — 운영 화면에서 사유를 확인해 주세요.', v_tag),
        interval '1 day'
      );
    end if;
  end if;

  return format('임베딩 %s건 · 태깅 %s건 되돌림', v_emb, v_tag);
end;
$recover$;

comment on function public.auto_recover() is
  '하루 한 번, 재시도 한도를 넘겨 세워 둔 임베딩과 태깅 조항을 다시 대상에 넣는다';

revoke execute on function public.auto_recover() from public;
revoke execute on function public.auto_recover() from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 언제 도는가
--
-- 재시도는 5분마다. ops_watch 가 그 주기로 job_run 의 결과를 채우므로, 그보다
-- 자주 돌면 아직 결과가 안 채워진 것을 보게 된다.
--
-- 자동 복구는 하루 한 번, 새벽에. 태깅 재시도에 돈이 들고 시간도 걸리므로
-- 담당자가 화면을 보는 낮 시간대를 피한다(KST 04:10 = UTC 19:10).
-- -----------------------------------------------------------------------------
select cron.unschedule('job-retry')
where exists (select 1 from cron.job where jobname = 'job-retry');
select cron.schedule('job-retry', '*/5 * * * *', $job$select public.retry_failed_jobs()$job$);

select cron.unschedule('auto-recover')
where exists (select 1 from cron.job where jobname = 'auto-recover');
select cron.schedule('auto-recover', '10 19 * * *', $job$select public.auto_recover()$job$);
