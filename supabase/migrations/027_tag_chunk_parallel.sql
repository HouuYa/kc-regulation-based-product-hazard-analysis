-- =============================================================================
-- 코드 부여 자동 실행을 병렬로 — 실측으로 드러난 두 가지를 고친다
--
-- 026 을 배포하고 4분간 재 봤더니 18건을 처리했다(시간당 270건, 남은 5,865건에
-- 약 21.7시간). "눌러 두면 끝난다"는 되지만 하루가 걸린다. 응답을 들여다보니
-- 두 가지 문제가 있었다.
--
-- 문제 1 — 504 Inactivity Timeout
--   {"status_code": 504, "response": "<HTML><TITLE>Inactivity Timeout</TITLE>"}
--   한 번에 25초를 쓰게 했는데, 함수를 띄우고 코드북을 읽는 준비 시간이 앞뒤로
--   붙어 전체 요청이 30초를 넘겼다. 실패한 tick 은 통째로 헛돌았고, 게다가
--   ops_watch 가 이것을 「정기 작업 실패」로 보고 알림까지 보낸다 — 밤새 켜 두면
--   실패 알림만 쌓인다. 예산을 18초로 낮췄다(route.ts).
--
-- 문제 2 — 준비 시간이 매번 새로 든다
--   {"elapsedMs": 25032, "done": 1, "stoppedEarly": true}
--   25초를 쓰고 1건만 한 tick 이 있었다. 로컬에서는 1건당 4.75초였으므로,
--   나머지 20초는 함수 기동·DB 연결·코드북 적재에 쓰인 셈이다. 서버리스는
--   요청마다 새로 뜨므로 이 준비 시간을 없앨 수는 없다.
--
--   그래서 없애는 대신 나눠 갖는다 — 한 tick 에 요청을 세 개 띄운다.
--   세 개가 각자 뜨면서 준비도 동시에 하므로, 준비 시간이 세 배로 늘지 않고
--   실제 작업 시간만 세 배가 된다.
--
-- 같은 조항을 두 번 처리하지 않는 방법
--   요청마다 "목록의 앞에서 몇 개를 건너뛸지"를 준다(offset 0 / 40 / 80).
--   한 요청이 18초에 처리하는 건수는 많아야 열 몇 건이므로, 40 간격이면 서로
--   구간이 겹치지 않는다. 겹치면 돈이 두 배로 나가므로 간격을 넉넉히 뒀다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 작업 하나를 주소 뒤에 붙는 값과 함께 부른다
--
-- run_job() 은 그대로 두고 확장판을 따로 만든다. 리콜 수집·기준 동기화는 나눌
-- 구간이라는 개념이 없어서 인자를 늘릴 이유가 없다.
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

  insert into public.job_run (job, request_id) values (p_job, v_req);
  return v_req;
end;
$run_job_at$;

revoke execute on function public.run_job_at(text, text) from public;

-- -----------------------------------------------------------------------------
-- 1분마다 — 세 갈래로 나눠 보낸다
-- -----------------------------------------------------------------------------
create or replace function public.run_tag_chunk()
returns text
language plpgsql
security definer
set search_path = ''
as $tag_chunk$
declare
  v_left int;
  v_off  int;
begin
  -- 겹침 방지.
  --
  -- 026 에서는 "아직 안 끝난 기록이 있으면 건너뛴다"로 했는데, 이제 한 tick 에
  -- 세 건을 보내고 결과는 ops_watch 가 5분마다 채우므로 그 조건이면 늘 걸린다.
  -- 시각으로 본다 — 45초 안에 보낸 것이 있으면 아직 도는 중이다(예산 18초 + 준비).
  if exists (
    select 1 from public.job_run
    where job = 'tag-chunk' and started_at > now() - interval '45 seconds'
  ) then
    return '앞 작업이 진행 중 — 건너뜀';
  end if;

  -- 남은 것이 없으면 스스로 꺼진다. 켜 둔 채로 빈 요청을 계속 보낼 이유가 없다.
  select count(*)::int into v_left
  from public.clause c
  join public.standard s on s.id = c.standard_id
  where s.is_current and c.clause_role = 'REQUIREMENT'
    and length(btrim(c.body)) >= 15
    and not exists (select 1 from public.clause_tag t where t.clause_id = c.id);

  if v_left = 0 then
    perform public.set_auto_tagging(false);
    perform public.ops_notify(
      '코드 부여 완료',
      E'모든 요건 조항에 위해요인 코드가 부여됐습니다.\n자동 실행은 스스로 껐습니다.',
      interval '0'
    );
    return '남은 조항 없음 — 자동 실행을 껐습니다';
  end if;

  -- 남은 것이 적으면 갈래를 줄인다. 40건도 안 남았는데 세 갈래로 나누면
  -- 두 갈래는 빈손으로 돌아온다(그래도 함수는 뜨므로 시간만 버린다).
  for v_off in
    select o from unnest(array[0, 40, 80]) as o where o < v_left
  loop
    perform public.run_job_at('tag-chunk', 'offset=' || v_off);
  end loop;

  return format('요청함 (남은 조항 %s건)', v_left);
end;
$tag_chunk$;

revoke execute on function public.run_tag_chunk() from public;
