-- =============================================================================
-- 운영 알림 — 문제가 생기면 텔레그램으로 알린다
--
-- 왜 DB 에서 보내는가
--   알려야 할 문제가 DB 안에서 생기기 때문이다. 임베딩 자동 배치(020)는 웹사이트가
--   떠 있든 말든 1분마다 돌고, 담당자가 화면을 안 보는 밤에도 실패할 수 있다.
--   알림을 Next.js 쪽에 두면 "아무도 화면을 안 보면 알림도 안 간다"가 되어
--   알림의 존재 이유가 사라진다. 020 이 이미 pg_net 을 깔아 뒀으므로 보낼 길도 있다.
--
-- 형식은 담당자가 쓰던 n8n Error Trigger 를 따랐다
--   docs/n8nErrorTrigger/Error Trigger.json 이 이미 같은 텔레그램 대화로
--   "무엇이 / 무슨 오류 / 언제" 세 줄을 보내고 있다. 사람이 이미 익숙한 형식을
--   바꿀 이유가 없어 같은 뼈대를 쓴다. 다만 parse_mode 는 쓰지 않는다 —
--   오류 메시지에 < & 같은 문자가 섞이면 HTML 파싱이 깨져 알림 자체가 유실된다.
--
-- 무엇을 알리는가 (세 가지만)
--   1) 임베딩 보류(parked)  재시도로 안 풀리는 행이 생겼다 — 사람이 봐야 한다
--   2) cron 실행 실패        배치 자체가 죽었다 — 가장 위험한 신호다
--   3) 임베딩 모델 혼재      좌표계가 섞였다. 검색이 조용히 망가지는 유일한 경우다
--
--   "알림이 시끄러우면 아무도 안 본다"가 이 목록이 짧은 이유다. 나머지(대기 건수,
--   개별 실패 1건 등)는 알리지 않는다 — 스스로 회복되는 것들이라 화면으로 충분하다.
--
-- 토큰은 Vault 에 둔다
--   이 파일에는 봇 토큰도 대화 번호도 없다. `npm run ops:secret` 이 넣는다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 보낸 알림 장부 — 같은 말을 반복하지 않기 위한 것
-- -----------------------------------------------------------------------------
create table if not exists public.ops_alert (
  id          bigint generated always as identity primary key,
  kind        text        not null,
  body        text        not null,
  request_id  bigint,
  status_code int,
  sent_at     timestamptz not null default now()
);

comment on table  public.ops_alert            is '보낸 운영 알림 기록. 같은 kind 를 쿨다운 안에 두 번 보내지 않는 근거가 된다';
comment on column public.ops_alert.kind       is '알림 종류. 이 값이 같으면 쿨다운 동안 다시 보내지 않는다';
comment on column public.ops_alert.status_code is '텔레그램 응답 코드. null = 아직 확인 전, 200 = 전달됨';

create index if not exists ops_alert_kind_idx on public.ops_alert (kind, sent_at desc);

alter table public.ops_alert enable row level security;
revoke all on table public.ops_alert from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 알림 한 건 보내기
--
-- 반환값
--   true  실제로 보냈다
--   false 쿨다운에 걸려 보내지 않았다 (또는 토큰이 없어 보낼 수 없다)
-- -----------------------------------------------------------------------------
create or replace function public.ops_notify(
  p_kind     text,
  p_body     text,
  p_cooldown interval default interval '6 hours'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $notify$
declare
  v_token text;
  v_chat  text;
  v_req   bigint;
  v_text  text;
begin
  -- 쿨다운 — 같은 종류의 문제로 1분마다 알림이 오면 아무도 안 읽게 된다
  if exists (
    select 1 from public.ops_alert
    where kind = p_kind and sent_at > now() - p_cooldown
  ) then
    return false;
  end if;

  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';
  select decrypted_secret into v_chat  from vault.decrypted_secrets where name = 'telegram_chat_id';

  -- 알림을 못 보내는 것이 배치를 멈출 이유는 되지 않는다. 조용히 넘긴다.
  -- (설정이 안 됐다는 사실은 운영 화면이 따로 보여 준다)
  if v_token is null or v_chat is null then
    return false;
  end if;

  v_text := format(
    E'[KC 제품위해 분석]\n%s\n\n%s\n\ndate&Time : %s',
    p_kind,
    p_body,
    to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI')
  );

  select net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body    := jsonb_build_object('chat_id', v_chat, 'text', v_text),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 15000
  ) into v_req;

  insert into public.ops_alert (kind, body, request_id) values (p_kind, p_body, v_req);
  return true;
end;
$notify$;

-- -----------------------------------------------------------------------------
-- 감시 — 5분마다 세 가지를 보고 필요하면 알린다
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
  v_msg      text;
  v_sent     int := 0;
  r          record;
begin
  -- 지난번에 보낸 알림들의 전달 여부를 먼저 채운다 (pg_net 은 비동기다)
  for r in
    select id, request_id from public.ops_alert
    where status_code is null and request_id is not null and sent_at > now() - interval '1 day'
  loop
    update public.ops_alert a
    set status_code = resp.status_code
    from net._http_response resp
    where a.id = r.id and resp.id = r.request_id;
  end loop;

  -- 1) 재시도로 풀리지 않는 임베딩
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
      '임베딩 보류 ' || v_parked || '건',
      format(E'재시도 5회로도 임베딩이 만들어지지 않은 행이 있습니다.\n담당자 확인이 필요합니다.\n\n%s', v_msg)
    ) then v_sent := v_sent + 1; end if;
  end if;

  -- 2) 배치 자체가 죽은 경우 — 가장 위험한 신호다
  select count(*)::int into v_failed
  from cron.job_run_details
  where status = 'failed' and end_time > now() - interval '15 minutes';

  if v_failed > 0 then
    select string_agg(format('%s: %s', j.jobname, left(coalesce(d.return_message, ''), 200)), E'\n')
      into v_msg
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where d.status = 'failed' and d.end_time > now() - interval '15 minutes';

    if public.ops_notify(
      '자동 배치 실행 실패',
      format(E'최근 15분 안에 %s회 실패했습니다.\n\n%s', v_failed, v_msg),
      interval '1 hour'   -- 이건 급하므로 쿨다운을 짧게 둔다
    ) then v_sent := v_sent + 1; end if;
  end if;

  -- 3) 임베딩 모델 혼재 — 검색이 조용히 망가지는 유일한 경우
  select count(distinct embedding_model)::int into v_models
  from public.clause where embedding is not null;

  if v_models > 1 then
    if public.ops_notify(
      '임베딩 모델 혼재',
      format(E'조항 임베딩에 서로 다른 모델 %s종이 섞였습니다.\n좌표계가 달라 검색 결과를 믿을 수 없습니다. 전량 재생성이 필요합니다.', v_models)
    ) then v_sent := v_sent + 1; end if;
  end if;

  return format('보류 %s / 배치실패 %s / 모델혼재 %s → 알림 %s건 발송', v_parked, v_failed, v_models, v_sent);
end;
$watch$;

-- -----------------------------------------------------------------------------
-- 운영 화면이 읽는 요약
-- -----------------------------------------------------------------------------
create or replace view public.ops_status
with (security_invoker = true) as
select
  (select count(*)::int from public.embed_queue where status = 'failed' and attempts >= 5) as parked,
  (select count(*)::int from public.embed_queue where status = 'failed')                   as failed,
  (select count(*)::int from public.embed_queue where status = 'sent')                     as in_flight,
  (select count(*)::int from cron.job_run_details d
    where d.status = 'failed' and d.end_time > now() - interval '24 hours')                as cron_failed_24h,
  (select count(distinct embedding_model)::int from public.clause where embedding is not null) as embedding_models,
  (select exists (select 1 from vault.decrypted_secrets where name = 'telegram_bot_token')) as telegram_configured,
  (select exists (select 1 from vault.decrypted_secrets where name = 'openai_api_key'))     as openai_configured,
  (select max(sent_at) from public.ops_alert)                                              as last_alert_at;

comment on view public.ops_status is '운영 화면(/ops) 한 줄 요약. 화면에서만 쓴다';

revoke all on public.ops_status from anon, authenticated;

revoke execute on function public.ops_notify(text, text, interval) from public;
revoke execute on function public.ops_watch()                      from public;

-- -----------------------------------------------------------------------------
-- 5분마다.
--
-- 1분이 아닌 이유: 이 함수가 보는 것들은 1분 안에 달라지지 않는다. 그리고
-- 알림은 늦어도 되지만 시끄러우면 안 된다 — 주기를 늘리는 쪽이 안전하다.
-- -----------------------------------------------------------------------------
select cron.unschedule('ops-watch')
where exists (select 1 from cron.job where jobname = 'ops-watch');

select cron.schedule('ops-watch', '*/5 * * * *', $job$select public.ops_watch()$job$);
