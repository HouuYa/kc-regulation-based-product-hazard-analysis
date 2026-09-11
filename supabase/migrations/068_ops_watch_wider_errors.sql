-- =============================================================================
-- ops_watch() 감시 범위를 넓힌다 — 정기 작업 밖의 오류도 잡는다
--
-- 담당자 요청 (2026-09-11) — 리콜 수집 504 건을 분석하다가 나온 질문이다.
--   "telegram에 다양한 오류가 나오면 알리도록 모니터링 범위를 확대해 달라"
--
-- 지금까지 025가 감시하던 다섯 가지는 전부 "정기 작업(job_run)"이나
-- "정기 배치(embed_queue·cron.job_run_details)" 범위 안의 실패였다. 그런데
-- 실패는 그 밖에서도 난다.
--
--   1) llm_call — 태깅·재채점·비전 같은 AI 호출은 정기 작업이 아니라 화면 조작
--      (분석 실행, 코드 부여 버튼 등) 중에도 일어난다. job_run은 정기 작업만
--      보므로 이런 실패는 지금까지 아무 데도 안 잡혔다 — 화면에 실패 결과만
--      뜨고, 아무도 안 보면 그냥 지나간다.
--   2) source_file — 원본 파일을 Storage에 저장하지 못하는 것도 같은 성격이다
--      (actions.ts의 storageError 갈래). 지금은 그 사건이 status='error'로
--      DB에만 남고 알림이 안 간다. PII 차단·스캔본은 업로드한 사람이 화면에서
--      바로 보므로 다시 알리지 않지만, 보관 실패는 Storage 쪽 장애일 수 있어
--      담당자가 화면을 열어 보지 않는 한 영영 모르고 지나간다.
--
-- 왜 job_run처럼 자동 재시도를 붙이지 않았나
--   이 둘은 035·036의 재시도 대상(job_run)과 성격이 다르다 — job_run은 "같은
--   구간을 다시 부르면 된다"는 게 분명하지만, llm_call 실패는 이미 tagging은
--   자체 재시도(029)를, source_file 보관 실패는 재업로드로 이어받는 경로
--   (actions.ts의 dup 갈래, 라운드 참고)가 이미 있다. 여기서는 "알리는 것"만
--   더한다 — 이중으로 재시도 로직을 만들면 어느 쪽이 실제로 재시도했는지
--   추적하기 더 어려워진다.
-- =============================================================================

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
  v_jobfail   int;
  v_waiting   int;
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

  -- 4) 정기 작업이 실패로 끝난 경우
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

  -- 5) 원문 확인이 오래 밀린 사고보고서
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

  -- 6) AI 호출 자체가 실패한 경우 (신규, 068) — 정기 작업 밖에서 나는 실패까지 잡는다.
  --    tagging·rerank·vision 등은 화면 조작(분석 실행, 코드 부여 등) 중에도
  --    불리는데, job_run은 정기 작업만 보므로 이런 실패는 지금까지 안 잡혔다.
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

  -- 7) 원본 파일 보관 실패 (신규, 068) — Storage 장애는 사람이 화면을 열어
  --    보지 않는 한 영영 모르고 지나간다. PII 차단·스캔본은 업로드한 사람이
  --    그 자리에서 바로 보므로 여기서 다시 알리지 않고, 보관 실패만 가려낸다.
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
    '보류 %s / 작업실패 %s / 기준혼재 %s / 정기작업실패 %s / 확인대기 %s / AI호출실패 %s / 보관실패 %s → 알림 %s건',
    v_parked, v_failed, v_models, v_jobfail, v_waiting, v_llmfail, v_storefail, v_sent
  );
end;
$watch$;

revoke execute on function public.ops_watch() from public;
revoke execute on function public.ops_watch() from anon, authenticated;
