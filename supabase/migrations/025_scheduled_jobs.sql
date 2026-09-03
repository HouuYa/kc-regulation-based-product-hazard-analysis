-- =============================================================================
-- 정기 실행 — 리콜 수집 · 안전기준 폴더 동기화
--
-- 담당자 질문: "npm run 을 꼭 로컬에서 해야하는지? 자동으로 돌아가도록 하기"
--
-- 조사해 보니 스크립트마다 답이 달랐다(근거는 각 스크립트 주석과 라운드 19 이력).
--
--   리콜 수집       로컬 파일 없음, 외부 표만 읽음, 재실행 안전 → 자동
--   기준 폴더 동기화 KC안전기준/ 76개 JSON 이 저장소에 있음      → 자동
--   조항 코드 부여   로컬 파일은 없으나 돈이 든다(약 $13)        → 사람이 버튼
--   사고보고서 적재  원본 PDF 가 개인정보라 저장소에 없다        → 로컬만
--   정확도 평가     사람이 손으로 채운 정답지가 있어야 한다      → 로컬만
--
-- 앞의 둘만 여기서 건다. 나머지는 클라우드에 재료가 없거나 사람의 결정이 필요하다.
--
-- 왜 pg_cron 이 HTTP 라우트를 부르는가
--   라운드 17의 임베딩 자동화는 DB 가 OpenAI 를 직접 불렀다. 로직이 "빈 행을 골라
--   API 에 보내고 결과를 쓴다"뿐이라 SQL 로 옮겨 적을 수 있었기 때문이다.
--   이번 둘은 다르다 — 리콜 적재는 코드북 대조·품목 확정·검색문 조립까지 하는
--   200줄짜리 TypeScript 다. 그걸 SQL 로 옮겨 적으면 두 벌이 되어 서로 어긋난다
--   (CLAUDE.md §9). 그래서 DB 는 부르기만 하고 로직은 한 벌로 둔다.
--
-- 비밀값 두 개가 필요하다 — `npm run ops:secret` 이 함께 넣는다
--   jobs_token     라우트를 부를 때 쓰는 열쇠 (JOBS_TOKEN 과 같은 값)
--   site_base_url  배포된 사이트 주소
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 실행 장부 — 무엇이 언제 돌아 무엇을 했는가
--
-- pg_net 은 비동기라 보낼 때는 결과를 모른다. ops_watch() 가 나중에 응답을 채운다.
-- 운영 화면의 "최근 처리 요약"이 이 표를 읽는다.
-- -----------------------------------------------------------------------------
create table if not exists public.job_run (
  id          bigint generated always as identity primary key,
  job         text        not null,
  request_id  bigint,
  status_code int,
  response    text,
  started_at  timestamptz not null default now(),
  settled_at  timestamptz
);

comment on table  public.job_run          is '정기 실행 기록. 무엇이 언제 돌아 무엇을 했는지 — 운영 화면이 이 표를 보여 준다';
comment on column public.job_run.response is '라우트가 돌려준 JSON 요약(처리 건수 등). 실패면 오류 내용';

create index if not exists job_run_started_idx on public.job_run (started_at desc);

alter table public.job_run enable row level security;
revoke all on table public.job_run from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 작업 하나 실행 요청
-- -----------------------------------------------------------------------------
create or replace function public.run_job(p_job text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $run_job$
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
    url     := rtrim(v_base, '/') || '/api/jobs/' || p_job,
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_token),
    -- 리콜 수집은 건수가 많으면 오래 걸린다. 서버리스 제한(보통 26초)보다 넉넉히 준다
    timeout_milliseconds := 60000
  ) into v_req;

  insert into public.job_run (job, request_id) values (p_job, v_req);
  return v_req;
end;
$run_job$;

comment on function public.run_job(text) is
  '정기 실행 작업을 HTTP 로 부른다. 결과는 비동기라 ops_watch() 가 나중에 채운다';

revoke execute on function public.run_job(text) from public;

-- -----------------------------------------------------------------------------
-- 감시 함수 확대
--
--   1) 보낸 작업의 결과를 채운다
--   2) 알릴 것을 세 가지에서 다섯 가지로 늘린다 (담당자 요청)
--        추가: 작업 실행 실패 / 원문 확인이 오래 밀린 사고보고서
-- -----------------------------------------------------------------------------
create or replace function public.ops_watch()
returns text
language plpgsql
security definer
set search_path = ''
as $watch$
declare
  v_parked   int;
  v_failed   int;
  v_models   int;
  v_jobfail  int;
  v_waiting  int;
  v_msg      text;
  v_sent     int := 0;
  r          record;
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

  -- 4) 정기 작업이 실패로 끝난 경우 (신규)
  select count(*)::int into v_jobfail
  from public.job_run
  where settled_at > now() - interval '1 hour'
    and (status_code is null or status_code <> 200);

  if v_jobfail > 0 then
    select string_agg(format('%s: HTTP %s %s', job, coalesce(status_code, 0), left(coalesce(response, ''), 150)), E'\n')
      into v_msg
    from public.job_run
    where settled_at > now() - interval '1 hour'
      and (status_code is null or status_code <> 200);

    if public.ops_notify(
      '정기 작업 실패',
      format(E'리콜 수집이나 기준 동기화가 실패했습니다.\n\n%s', v_msg),
      interval '2 hours'
    ) then v_sent := v_sent + 1; end if;
  end if;

  -- 5) 원문 확인이 오래 밀린 사고보고서 (신규)
  --    확인하지 않으면 분석 대상이 되지 않는다. 잊고 지나가기 쉬운 자리라 알린다.
  select count(*)::int into v_waiting
  from public.case_event
  where source_type = 'ACCIDENT' and not is_confirmed
    and created_at < now() - interval '7 days';

  if v_waiting > 0 then
    if public.ops_notify(
      '원문 확인 대기 ' || v_waiting || '건',
      E'올린 지 7일이 지났는데 아직 원문 확인을 하지 않은 사고보고서가 있습니다.\n확인해야 분석 대상이 됩니다.',
      interval '3 days'
    ) then v_sent := v_sent + 1; end if;
  end if;

  return format('보류 %s / 작업실패 %s / 기준혼재 %s / 정기작업실패 %s / 확인대기 %s → 알림 %s건',
                v_parked, v_failed, v_models, v_jobfail, v_waiting, v_sent);
end;
$watch$;

revoke execute on function public.ops_watch() from public;

-- -----------------------------------------------------------------------------
-- 주기 등록 — 하루 1회씩. 시간은 UTC 이므로 +9 하면 한국 시각이다.
--
-- 리콜과 기준을 10분 떨어뜨린 이유는 둘이 동시에 돌면 어느 쪽이 느린지 구분하기
-- 어렵기 때문이다. 새벽에 두는 것은 습관이지 성능 때문이 아니다.
-- -----------------------------------------------------------------------------
select cron.unschedule('job-recalls-fetch')
where exists (select 1 from cron.job where jobname = 'job-recalls-fetch');
select cron.unschedule('job-standards-sync')
where exists (select 1 from cron.job where jobname = 'job-standards-sync');

-- 03:40 KST
select cron.schedule('job-recalls-fetch',  '40 18 * * *', $job$select public.run_job('recalls-fetch')$job$);
-- 03:50 KST
select cron.schedule('job-standards-sync', '50 18 * * *', $job$select public.run_job('standards-sync')$job$);
