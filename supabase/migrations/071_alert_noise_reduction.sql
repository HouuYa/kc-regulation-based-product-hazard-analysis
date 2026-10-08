-- =============================================================================
-- 텔레그램 알림을 "진짜 오류"만 보내도록 고친다 — 그리고 고장 난 자동 재시도를 되살린다
--
-- 담당자 요청 (2026-10-07)
--   "정기적으로 telegram 으로 에러를 보내오는데, 가져올 것이 없다는 코드는 보내지
--    말고 진짜 오류만 보내도록 개선해 달라"
--
-- 실측 (ops_alert · job_run, 2026-10-07 조회)
--   보낸 알림 151건 중 120건(79%)이 「정기 작업 실패」였다. 지난 14일만 보면 42건.
--   그 원인인 실패 기록은 recalls-fetch 의 504(Inactivity Timeout) 167건, 502 64건,
--   500(원천 서버가 HTML 오류 쪽을 돌려줌) 7건이 대부분이다.
--   그런데 14일 동안 정기 작업 14,112번 중 성공이 14,047번(99.5%)이었고, 실패 직후의
--   다음 실행은 거의 모두 성공했다. 리콜 수집은 26.7시간마다 전체를 다시 훑으므로
--   실패한 구간도 다음 바퀴에 저절로 채워진다 — 사람이 할 일이 없는 알림이었다.
--
-- 고장 하나를 같이 찾았다 — 035 의 자동 재시도가 9월 8일부터 한 번도 돌지 않았다
--   035 는 run_job_at 이 job_run 에 구간(query)을 남기도록 고쳤고, 재시도는 그
--   구간을 다시 보낸다(036: 구간을 모르면 다시 보내지 않는다). 그런데 9월 8일
--   db:push 가 장부(schema_migration)에 없던 025~034 를 뒤늦게 적용하면서 027 의
--   옛 run_job_at(구간을 안 남기는 판)이 035 판을 덮어썼다. 그 뒤 14,112건 전부
--   query 가 null 이라 retry_failed_jobs() 는 864번 돌며 매번 0건을 보냈다.
--   여기서 035 판으로 되돌린다.
--
-- 알림 규칙을 이렇게 바꾼다 (정기 작업 실패 부분만)
--   보내지 않는 것  일시적 실패(502·503·504·응답 없음) 1~2번. 다음 실행·재시도가 메운다
--   보내는 것      1) 작업이 30분 넘게 한 번도 성공하지 못했다 — 진짜 장애
--                  2) 같은 구간이 재시도까지 3번 모두 실패했다 — 그 자료에 무언가 있다
--                  3) 4xx — 토큰·주소 같은 설정 오류. 스스로 낫지 않으므로 바로 알린다
--   이 규칙을 지난 14일 기록에 그대로 대 보면 옛 규칙은 159번 조건에 걸렸고(쿨다운
--   덕에 실제 발송 42건), 새 규칙은 0번이다. 그 기간에 30분 넘게 막힌 적은 없었다.
--
-- 그 밖에 바꾸는 것
--   - 「원문 확인 대기 N건」은 3일마다 같은 65건을 되풀이했다(10건). 건수가 늘었을
--     때, 또는 마지막 알림 뒤 14일이 지났을 때만 보낸다.
--   - 오류 본문에 HTML(504 쪽 전체)이 그대로 실려 왔다. 상태 코드를 사람 말로
--     옮기고, 남는 본문은 태그를 걷어 낸 뒤 짧게 자른다.
--   - 새 리콜 도착·기준 갱신 같은 좋은 소식은 그대로 둔다. 들어온 것이 없으면
--     원래부터 보내지 않는다(api/jobs/[job]/route.ts 의 newCase > 0 조건).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) run_job_at 을 035 판으로 되돌린다 — 구간(query)을 남겨야 재시도가 돈다
-- -----------------------------------------------------------------------------
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
-- 2) 실패 사유를 사람 말로 — 알림 본문에 HTML 이 통째로 실리지 않게 한다
-- -----------------------------------------------------------------------------
create or replace function public.ops_failure_reason(p_status int, p_response text)
returns text
language sql
immutable
set search_path = ''
as $reason$
  select case
    when p_status = 504 then '응답 시간 초과(배포 서버 30초 제한)'
    when p_status in (502, 503) then '배포 서버 일시 오류'
    when p_status = 0 or p_status is null then '응답 없음 · ' || left(coalesce(nullif(p_response, ''), '네트워크 오류'), 80)
    when p_status = 401 then '인증 실패 — jobs_token 이 사이트의 JOBS_TOKEN 과 다릅니다'
    when p_status = 404 then '주소 없음 — site_base_url 또는 작업 이름을 확인하세요'
    when p_response like '%조회 실패%' then '원천 자료 서버 응답 이상'
    else 'HTTP ' || p_status || ' · ' ||
         left(btrim(regexp_replace(regexp_replace(coalesce(p_response, ''), '<[^>]*>', ' ', 'g'), '\s+', ' ', 'g')), 120)
  end
$reason$;

revoke execute on function public.ops_failure_reason(int, text) from public;
revoke execute on function public.ops_failure_reason(int, text) from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3) ops_watch — 068 판에서 4)·5) 만 바꿨다. 나머지는 그대로다
-- -----------------------------------------------------------------------------
create or replace function public.ops_watch()
returns text
language plpgsql
security definer
set search_path = ''
as $watch$
declare
  v_parked    int;
  v_failed    int;
  v_models    int;
  v_outage    int := 0;
  v_exhausted int := 0;
  v_config    int := 0;
  v_waiting   int;
  v_last_wait int;
  v_last_at   timestamptz;
  v_llmfail   int;
  v_storefail int;
  v_msg       text;
  v_sent      int := 0;
  r           record;
begin
  -- 지난번에 보낸 알림들의 전달 여부를 채운다 (pg_net 은 비동기다)
  for r in
    select id, request_id from public.ops_alert
    where status_code is null and request_id is not null and sent_at > now() - interval '1 day'
  loop
    update public.ops_alert a
    set status_code = resp.status_code
    from net._http_response resp
    where a.id = r.id and resp.id = r.request_id;
  end loop;

  -- 보낸 작업의 결과를 채운다
  for r in
    select id, request_id from public.job_run
    where settled_at is null and request_id is not null and started_at > now() - interval '1 day'
  loop
    update public.job_run j
    set status_code = resp.status_code,
        response    = left(coalesce(resp.content, resp.error_msg, ''), 2000),
        settled_at  = now()
    from net._http_response resp
    where j.id = r.id and resp.id = r.request_id;
  end loop;

  -- 응답도 오류도 없이 오래 지난 것은 유실로 본다(pg_net 은 6시간 뒤 응답을 지운다)
  update public.job_run
  set status_code = 0, response = '응답 없음(10분 초과)', settled_at = now()
  where settled_at is null and started_at < now() - interval '10 minutes';

  -- 1) 재시도로 풀리지 않는 의미 검색 준비
  select count(*)::int into v_parked
  from public.embed_queue where status = 'failed' and attempts >= 5;

  if v_parked > 0 then
    select string_agg(format('%s #%s: %s', target_table, row_id, left(coalesce(last_error, ''), 100)),
                      E'\n' order by target_table, row_id)
      into v_msg
    from (
      select target_table, row_id, last_error from public.embed_queue
      where status = 'failed' and attempts >= 5 order by target_table, row_id limit 5
    ) t;

    if public.ops_notify(
      '의미 검색 준비 보류 ' || v_parked || '건',
      format(E'다섯 번 시도해도 준비되지 않은 자료가 있습니다.\n담당자 확인이 필요합니다.\n\n%s', v_msg)
    ) then v_sent := v_sent + 1; end if;
  end if;

  -- 2) 자동 작업 자체가 죽은 경우 — 가장 위험한 신호다
  select count(*)::int into v_failed
  from cron.job_run_details
  where status = 'failed' and end_time > now() - interval '15 minutes';

  if v_failed > 0 then
    select string_agg(format('%s: %s', j.jobname, left(coalesce(d.return_message, ''), 200)), E'\n')
      into v_msg
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where d.status = 'failed' and d.end_time > now() - interval '15 minutes';

    if public.ops_notify(
      '자동 작업 실행 실패',
      format(E'최근 15분 안에 %s회 실패했습니다.\n\n%s', v_failed, v_msg),
      interval '1 hour'
    ) then v_sent := v_sent + 1; end if;
  end if;

  -- 3) 의미 검색 기준(모델) 혼재 — 오류 없이 품질만 조용히 나빠지는 경우
  select count(distinct embedding_model)::int into v_models
  from public.clause where embedding is not null;

  if v_models > 1 then
    if public.ops_notify(
      '의미 검색 기준 혼재',
      format(E'조항에 서로 다른 기준(모델) %s종이 섞였습니다.\n같은 잣대로 잰 것이 아니라 검색 결과를 믿을 수 없습니다. 전량 다시 만들어야 합니다.', v_models)
    ) then v_sent := v_sent + 1; end if;
  end if;

  -- 4) 정기 작업 — 일시적 실패는 알리지 않는다 (071)
  --
  -- 4-1) 진짜 장애: 최근 15분 안에 실패가 있고, 30분 동안 성공이 한 번도 없다.
  --      리콜 수집은 2분, 기준 동기화는 5분마다 돌므로 30분이면 6~15번 연속 실패다.
  for r in
    select j.job,
           count(*)::int as n,
           (array_agg(public.ops_failure_reason(j.status_code, j.response) order by j.settled_at desc))[1] as reason
    from public.job_run j
    where j.settled_at > now() - interval '15 minutes'
      and (j.status_code is null or j.status_code <> 200)
      and not exists (
        select 1 from public.job_run k
        where k.job = j.job and k.status_code = 200
          and k.started_at > now() - interval '30 minutes'
      )
    group by j.job
  loop
    if public.ops_notify(
      '정기 작업 중단 · ' || r.job,
      format(E'30분 넘게 한 번도 성공하지 못했습니다(최근 15분 실패 %s회).\n마지막 사유: %s\n\n일시적 오류라면 저절로 풀립니다. 1시간 넘게 이어지면 배포 사이트(Netlify)와 원천 자료 서버 상태를 확인해 주세요.', r.n, r.reason),
      interval '2 hours'
    ) then v_sent := v_sent + 1; v_outage := v_outage + 1; end if;
  end loop;

  -- 4-2) 같은 구간이 재시도까지 모두 실패 — 장애가 아니라 그 자료에 문제가 있을 수 있다
  select count(*)::int,
         string_agg(format('%s %s: %s', job, coalesce(query, ''),
                           public.ops_failure_reason(status_code, response)), E'\n')
    into v_exhausted, v_msg
  from (
    select j.job, j.query, j.status_code, j.response
    from public.job_run j
    where j.attempt >= 3
      and j.settled_at > now() - interval '1 hour'
      and (j.status_code is null or j.status_code >= 500 or j.status_code = 0)
    order by j.settled_at desc
    limit 5
  ) t;

  if v_exhausted > 0 then
    if public.ops_notify(
      '정기 작업 구간 반복 실패',
      format(E'같은 구간이 재시도까지 세 번 모두 실패했습니다. 그 구간의 자료를 확인해 주세요.\n\n%s', v_msg),
      interval '6 hours'
    ) then v_sent := v_sent + 1; end if;
  end if;

  -- 4-3) 4xx — 설정 오류. 스스로 낫지 않는다
  select count(*)::int,
         string_agg(distinct format('%s: %s', job, public.ops_failure_reason(status_code, response)), E'\n')
    into v_config, v_msg
  from public.job_run
  where settled_at > now() - interval '1 hour'
    and status_code between 400 and 499;

  if v_config > 0 then
    if public.ops_notify(
      '정기 작업 설정 오류',
      format(E'최근 1시간 %s회 — 다시 시도해도 낫지 않는 오류입니다.\n\n%s', v_config, v_msg),
      interval '2 hours'
    ) then v_sent := v_sent + 1; end if;
  end if;

  -- 5) 원문 확인이 오래 밀린 사고보고서 — 건수가 늘었거나 14일이 지났을 때만 (071)
  select count(*)::int into v_waiting
  from public.case_event
  where source_type = 'ACCIDENT' and not is_confirmed
    and created_at < now() - interval '7 days';

  if v_waiting > 0 then
    select nullif(regexp_replace(kind, '\D', '', 'g'), '')::int, sent_at
      into v_last_wait, v_last_at
    from public.ops_alert
    where kind like '원문 확인 대기%'
    order by sent_at desc
    limit 1;

    if v_last_at is null
       or v_waiting > coalesce(v_last_wait, 0)
       or v_last_at < now() - interval '14 days' then
      if public.ops_notify(
        '원문 확인 대기 ' || v_waiting || '건',
        E'올린 지 7일이 지났는데 아직 원문 확인을 하지 않은 사고보고서가 있습니다.\n확인해야 분석 대상이 됩니다.',
        interval '1 day'
      ) then v_sent := v_sent + 1; end if;
    end if;
  end if;

  -- 6) AI 호출 자체가 실패한 경우 (068)
  select count(*)::int into v_llmfail
  from public.llm_call
  where not ok and called_at > now() - interval '15 minutes';

  if v_llmfail > 0 then
    select string_agg(format('%s(%s): %s', purpose, model, left(coalesce(error, ''), 150)), E'\n')
      into v_msg
    from (
      select purpose, model, error from public.llm_call
      where not ok and called_at > now() - interval '15 minutes'
      order by called_at desc limit 5
    ) t;

    if public.ops_notify(
      'AI 호출 실패 ' || v_llmfail || '건',
      format(E'최근 15분 안에 AI 호출이 %s건 실패했습니다.\n\n%s', v_llmfail, v_msg),
      interval '1 hour'
    ) then v_sent := v_sent + 1; end if;
  end if;

  -- 7) 원본 파일 보관 실패 (068)
  select count(*)::int into v_storefail
  from public.source_file
  where status = 'error' and error_reason like '원본 보관에 실패%'
    and uploaded_at > now() - interval '1 hour';

  if v_storefail > 0 then
    if public.ops_notify(
      '원본 파일 보관 실패 ' || v_storefail || '건',
      format(E'최근 1시간 안에 원본 파일을 Storage에 저장하지 못했습니다(%s건).\nSupabase Storage 상태를 확인해 주세요. 담당자가 같은 파일을 다시 올리면 자동으로 이어받습니다.', v_storefail),
      interval '1 hour'
    ) then v_sent := v_sent + 1; end if;
  end if;

  return format(
    '보류 %s / 작업실패 %s / 기준혼재 %s / 정기작업중단 %s·구간반복실패 %s·설정오류 %s / 확인대기 %s / AI호출실패 %s / 보관실패 %s → 알림 %s건',
    v_parked, v_failed, v_models, v_outage, v_exhausted, v_config, v_waiting, v_llmfail, v_storefail, v_sent
  );
end;
$watch$;

revoke execute on function public.ops_watch() from public;
revoke execute on function public.ops_watch() from anon, authenticated;
