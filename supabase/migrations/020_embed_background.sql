-- =============================================================================
-- 임베딩 자동 생성 — DB 안에서 스스로 도는 배치 (pg_cron + pg_net)
--
-- 무엇을 해결하는가
--   지금까지 임베딩은 사람이 `npm run embed` 를 쳐야 생겼다. 기준을 새로 적재하거나
--   리콜을 새로 받아 오면 그 자료는 명령을 칠 때까지 의미검색(벡터 갈래)에 잡히지
--   않는다. 키워드 갈래(pgroonga)는 search_text 만 있으면 바로 잡히므로, 이 상태는
--   "새 자료는 반쪽만 검색된다"는 조용한 결함이었다. 이 마이그레이션은 그 빈칸을
--   1분마다 DB 가 스스로 메우게 한다.
--
-- 왜 Edge Function 이 아니라 pg_net 직접 호출인가 (2026-09-03 실측으로 결정)
--   원래 계획은 pg_cron → Edge Function → OpenAI 였다. 그런데 Edge Function 배포에는
--   Supabase CLI 설치·로그인이 필요하고(이 세션에 연결된 Supabase MCP 계정은 이
--   프로젝트가 속한 조직이 아니라 접근이 안 된다), 그 단계에서 진행이 막힌다.
--   실제로 확인해 보니 우리 DATABASE_URL 의 postgres 롤로 pg_net·pg_cron 을
--   `create extension` 할 수 있었다(트랜잭션 안에서 시험 후 롤백해 확인).
--   그러면 배포 도구 없이 이 파일 하나로 끝난다. 중간 단계가 하나 없어지는 만큼
--   고장 날 곳도 하나 줄어든다.
--
--   대신 잃는 것도 적어 둔다: 재시도·오류 로그가 TypeScript 보다 거칠고, 로직이
--   SQL 이라 읽기 어렵다. 그럼에도 이 선택이 나은 이유는 여기서 필요한 로직이
--   "임베딩이 빈 행을 골라 API 에 보내고 결과를 써 넣는다"뿐이기 때문이다.
--   어려운 부분인 search_text 조립(SEARCH_TEXT_VARIANT, §5.2.4)은 이미 적재
--   단계에서 끝나 컬럼에 저장돼 있다. 즉 TypeScript 로직을 SQL 로 옮겨 적는
--   중복이 사실상 생기지 않는다(CLAUDE.md §9 가 경계하는 상황이 아니다).
--
-- 왜 한 요청에 한 행인가 (배치로 묶지 않는 이유)
--   OpenAI 임베딩은 토큰 단위 과금이라 여러 건을 묶어도 돈이 덜 들지 않는다.
--   묶으면 요청 수만 줄고, 대신 (a) 응답 배열의 index 를 행에 되짚어 맞추는 코드와
--   (b) 한 건이 실패하면 묶음 전체가 실패하는 문제, (c) 실패 횟수를 행 단위로
--   세지 못하는 문제가 생긴다. 한 행 = 한 요청으로 두면 큐 테이블이 그대로
--   행 단위 재시도 장부가 되어 이 셋이 전부 사라진다. pg_net 은 비동기라
--   동시에 수십 건을 띄우므로 속도도 문제되지 않는다.
--   (대량 최초 생성은 여전히 `npm run embed` 가 빠르다. 이 배치는 증분용이다.)
--
-- pg_net 은 비동기다 — 그래서 두 단계로 나뉜다
--   net.http_post() 는 요청을 큐에 넣고 번호(request_id)만 즉시 돌려준다.
--   응답은 잠시 뒤 net._http_response 에 나타난다(기본 6시간 보관).
--   그래서 embed_tick() 은 매번 "지난 요청 결과 수거 → 새 요청 발송" 순으로 돈다.
--
-- API 키는 Vault 에 둔다
--   이 파일에는 키가 없다. `npm run embed:secret` 이 .env.local 의 OPENAI_API_KEY 를
--   읽어 vault 에 넣는다(CLAUDE.md §7 — 실제 키는 저장소에 올라가지 않는다).
-- =============================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- -----------------------------------------------------------------------------
-- 발송 장부
--
-- 성공한 행은 지운다. 남아 있는 행 = 아직 응답을 못 받았거나(sent) 실패한 것(failed).
-- 그래서 이 표의 크기가 곧 "지금 문제가 있는 건수"가 된다 — 13,501건이 다 쌓이는
-- 표가 아니다.
-- -----------------------------------------------------------------------------
create table if not exists public.embed_queue (
  target_table text        not null check (target_table in ('clause', 'case_event')),
  row_id       bigint      not null,
  request_id   bigint,
  status       text        not null default 'sent' check (status in ('sent', 'failed')),
  attempts     int         not null default 1,
  last_error   text,
  sent_at      timestamptz not null default now(),
  settled_at   timestamptz,
  primary key (target_table, row_id)
);

comment on table  public.embed_queue            is '임베딩 자동 생성의 발송 장부. 성공 시 행을 지우므로 남은 행 수 = 미해결 건수';
comment on column public.embed_queue.request_id is 'net.http_post() 가 준 번호. net._http_response.id 와 맞춰 결과를 찾는다';
comment on column public.embed_queue.attempts   is '이 행을 몇 번 시도했는가. 5회에 이르면 더 시도하지 않고 세워 둔다(무한 재시도 방지)';
comment on column public.embed_queue.last_error is '마지막 실패 사유. 담당자가 embed_status 로 보고 판단한다';

create index if not exists embed_queue_status_idx on public.embed_queue (status, settled_at);

-- 서버 전용. 외부 키(anon/authenticated)로는 닿지 않게 한다.
alter table public.embed_queue enable row level security;
revoke all on table public.embed_queue from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 결과 수거 — 지난 요청의 응답을 벡터로 바꿔 써 넣는다
-- -----------------------------------------------------------------------------
create or replace function public.embed_collect()
returns int
language plpgsql
security definer
set search_path = ''
as $collect$
declare
  q       record;
  r       record;
  v_done  int := 0;
  v_model text;
begin
  for q in
    select * from public.embed_queue where status = 'sent' order by sent_at
  loop
    begin
      select * into r from net._http_response where id = q.request_id;

      if not found then
        -- 아직 안 왔다. 다만 10분이 넘도록 응답도 오류도 없으면 그 요청은 유실된
        -- 것으로 본다(pg_net 은 6시간 뒤 응답을 지운다 — 그 전에 손절해야 이 행이
        -- 영영 'sent' 로 묶여 재시도 대상에서 빠지는 일을 막는다).
        if q.sent_at < now() - interval '10 minutes' then
          update public.embed_queue
          set status = 'failed', last_error = '응답 없음(10분 초과)', settled_at = now()
          where target_table = q.target_table and row_id = q.row_id;
        end if;
        continue;
      end if;

      if r.status_code = 200 then
        -- 모델명은 응답이 알려 준다. 우리가 보낸 이름과 OpenAI 가 실제로 쓴 이름이
        -- 다를 수 있어(별칭 → 실제 스냅샷) 응답 쪽을 기록한다. §2.2 의 요구는
        -- "무엇으로 만든 벡터인지 되짚을 수 있어야 한다"는 것이므로 실제 이름이 맞다.
        v_model := coalesce(r.content::jsonb ->> 'model', 'unknown');

        if q.target_table = 'clause' then
          update public.clause
          set embedding       = ((r.content::jsonb -> 'data' -> 0 -> 'embedding')::text)::extensions.vector(1536),
              embedding_model = v_model,
              embedded_at     = now()
          where id = q.row_id;
        else
          update public.case_event
          set embedding       = ((r.content::jsonb -> 'data' -> 0 -> 'embedding')::text)::extensions.vector(1536),
              embedding_model = v_model
          where id = q.row_id;
        end if;

        -- 성공하면 장부에서 지운다
        delete from public.embed_queue where target_table = q.target_table and row_id = q.row_id;
        v_done := v_done + 1;
      else
        update public.embed_queue
        set status     = 'failed',
            last_error = format('HTTP %s %s', coalesce(r.status_code, 0),
                                left(coalesce(r.error_msg, r.content, ''), 300)),
            settled_at = now()
        where target_table = q.target_table and row_id = q.row_id;
      end if;

    exception
      -- 응답이 우리가 기대한 모양이 아니어도(JSON 아님, embedding 필드 없음, 차원
      -- 불일치 등) 배치 전체가 죽으면 안 된다. 한 건씩 감싸 그 건만 실패로 남긴다.
      when others then
        update public.embed_queue
        set status = 'failed', last_error = left('수거 중 예외: ' || sqlerrm, 300), settled_at = now()
        where target_table = q.target_table and row_id = q.row_id;
    end;
  end loop;

  return v_done;
end;
$collect$;

-- -----------------------------------------------------------------------------
-- 발송 — 임베딩이 빈 행을 골라 OpenAI 에 보낸다
-- -----------------------------------------------------------------------------
create or replace function public.embed_dispatch(p_limit int default 40)
returns int
language plpgsql
security definer
set search_path = ''
as $dispatch$
declare
  v_key    text;
  v_model  text;
  v_models int;
  v_budget int := p_limit;
  v_sent   int := 0;
  v_req    bigint;
  c        record;
begin
  -- 보낼 것이 있는지부터 싸게 확인한다. 대부분의 tick 은 여기서 끝난다.
  if not exists (
    select 1 from public.clause
    where embedding is null and search_text is not null and length(btrim(search_text)) > 0
    union all
    select 1 from public.case_event
    where embedding is null and search_text is not null and length(btrim(search_text)) > 0
  ) then
    return 0;
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'openai_api_key';
  if v_key is null then
    raise exception 'vault 에 openai_api_key 가 없습니다. `npm run embed:secret` 을 먼저 실행하세요.';
  end if;

  -- 모델을 환경변수가 아니라 "이미 쌓인 벡터"에서 가져온다.
  --
  -- 이 배치는 .env.local 을 읽을 수 없다. 모델명을 여기 적어 두면 누군가
  -- OPENAI_EMBEDDING_MODEL 을 바꿨을 때 CLI 와 이 배치가 서로 다른 모델로 벡터를
  -- 만들어 한 표에 섞인다 — src/lib/llm/client.ts 가 경고하는 바로 그 사고다.
  -- 이미 있는 벡터의 모델을 그대로 따라가면 이 배치는 좌표계를 새로 만들 수 없다.
  select count(distinct embedding_model) into v_models
  from public.clause where embedding is not null;

  if v_models > 1 then
    raise exception '조항에 서로 다른 임베딩 모델이 섞여 있습니다(%종). 전량 재생성이 먼저입니다.', v_models;
  end if;

  select embedding_model into v_model
  from public.clause where embedding is not null limit 1;

  -- 표가 비어 있을 때만 기본값을 쓴다(src/lib/env.ts 의 기본값과 같아야 한다)
  v_model := coalesce(v_model, 'text-embedding-3-large');

  for c in
    select 'clause'::text as t, id, search_text from public.clause
    where embedding is null and search_text is not null and length(btrim(search_text)) > 0
    union all
    select 'case_event'::text, id, search_text from public.case_event
    where embedding is null and search_text is not null and length(btrim(search_text)) > 0
    order by 1, 2
  loop
    exit when v_budget <= 0;

    -- 이미 발송돼 응답을 기다리는 중이거나, 5회를 채워 세워 둔 행이거나,
    -- 실패한 지 10분이 안 된 행은 건너뛴다.
    if exists (
      select 1 from public.embed_queue q
      where q.target_table = c.t and q.row_id = c.id
        and (q.status = 'sent'
             or q.attempts >= 5
             or q.settled_at > now() - interval '10 minutes')
    ) then
      continue;
    end if;

    select net.http_post(
      url     := 'https://api.openai.com/v1/embeddings',
      body    := jsonb_build_object('model', v_model, 'input', c.search_text, 'dimensions', 1536),
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_key),
      timeout_milliseconds := 30000
    ) into v_req;

    insert into public.embed_queue as q (target_table, row_id, request_id, status, sent_at)
    values (c.t, c.id, v_req, 'sent', now())
    on conflict (target_table, row_id) do update
      set request_id = excluded.request_id,
          status     = 'sent',
          attempts   = q.attempts + 1,
          sent_at    = now(),
          settled_at = null;

    v_budget := v_budget - 1;
    v_sent   := v_sent + 1;
  end loop;

  return v_sent;
end;
$dispatch$;

-- -----------------------------------------------------------------------------
-- 1분마다 cron 이 부르는 진입점
-- -----------------------------------------------------------------------------
create or replace function public.embed_tick()
returns text
language plpgsql
security definer
set search_path = ''
as $tick$
declare
  v_done int;
  v_sent int;
begin
  -- 앞 tick 이 아직 돌고 있으면 이번은 건너뛴다. pg_cron 은 겹쳐서 실행하므로
  -- 이것이 없으면 같은 행을 두 번 보내 돈이 두 배로 나간다.
  if not pg_try_advisory_lock(4726001) then
    return '앞 실행이 진행 중 — 건너뜀';
  end if;

  v_done := public.embed_collect();
  v_sent := public.embed_dispatch();

  perform pg_advisory_unlock(4726001);
  return format('수거 %s건 / 발송 %s건', v_done, v_sent);
exception
  when others then
    perform pg_advisory_unlock(4726001);
    raise;
end;
$tick$;

-- -----------------------------------------------------------------------------
-- 상태 조회 — "자동 배치가 돌고 있는가"를 한 줄로 본다
--   select * from public.embed_status;
-- -----------------------------------------------------------------------------
create or replace view public.embed_status
with (security_invoker = true) as
with t as (
  select 'clause'::text as target_table,
         count(*)::int as total,
         count(*) filter (where embedding is not null)::int as embedded,
         count(*) filter (where embedding is null
                            and search_text is not null
                            and length(btrim(search_text)) > 0)::int as pending,
         count(distinct embedding_model)::int as models
  from public.clause
  union all
  select 'case_event',
         count(*)::int,
         count(*) filter (where embedding is not null)::int,
         count(*) filter (where embedding is null
                            and search_text is not null
                            and length(btrim(search_text)) > 0)::int,
         count(distinct embedding_model)::int
  from public.case_event
)
select t.target_table,
       t.total,
       t.embedded,
       t.pending,
       t.models,
       coalesce(q.in_flight, 0)::int as in_flight,
       coalesce(q.failed,    0)::int as failed,
       coalesce(q.parked,    0)::int as parked
from t
left join (
  select target_table,
         count(*) filter (where status = 'sent')::int   as in_flight,
         count(*) filter (where status = 'failed')::int as failed,
         count(*) filter (where status = 'failed' and attempts >= 5)::int as parked
  from public.embed_queue
  group by target_table
) q on q.target_table = t.target_table;

comment on view public.embed_status is
  'pending=아직 임베딩 없음, in_flight=발송 후 응답 대기, parked=5회 실패해 세워 둔 건(사람이 봐야 함)';

revoke all on public.embed_status from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 권한 — 009 의 방침 그대로 서버 전용으로 닫는다
-- (009 가 default privileges 를 이미 막아 두었지만, 의도를 파일에 남겨 둔다)
-- -----------------------------------------------------------------------------
revoke execute on function public.embed_collect()     from anon, authenticated;
revoke execute on function public.embed_dispatch(int) from anon, authenticated;
revoke execute on function public.embed_tick()        from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1분 주기 등록
--
-- 왜 1분인가: 보낼 것이 없는 tick 은 exists 조회 한 번으로 끝나 사실상 공짜다.
-- 그 대가로 새 자료를 적재하면 1분 안에 의미검색에 잡힌다 — "백그라운드로
-- 알아서 돌아간다"는 요구에 가장 가깝다.
-- -----------------------------------------------------------------------------
select cron.unschedule('embed-tick')
where exists (select 1 from cron.job where jobname = 'embed-tick');

select cron.schedule('embed-tick', '* * * * *', $job$select public.embed_tick()$job$);
