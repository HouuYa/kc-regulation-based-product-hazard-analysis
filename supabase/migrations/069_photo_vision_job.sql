-- =============================================================================
-- 사고사진 비전 분석을 배치 작업으로 등록한다 (068 설계의 마지막 조각)
--
-- 웹 업로드(src/app/accidents/actions.ts)는 이제 사진을 추출·Storage 저장까지만
-- 동기로 하고, 비전 분석(비용이 드는 LLM 호출)은 미룬다 — 사진이 많은 보고서에서
-- 배포 환경의 요청 시간 제한을 넘길 수 있기 때문이다(2026-09-11 리콜 수집 504로
-- 같은 문제를 실측했다, 067).
--
-- 026(조항 코드 부여)과 같은 패턴을 그대로 따른다 — 돈이 드는 LLM 호출은
-- 기본으로 자동 돌지 않는다(라운드 19 결정). 담당자가 /ops 에서 켜야 돈다.
-- 코드 부여와 달리 "다 끝나면 스스로 꺼짐" 로직은 두지 않았다 — 사고사진은
-- 연 50건 안팎(catalog.ts)이라 매번 몇 건씩 남아 있는 정상 상태가 대부분이고,
-- 켜 둬도 남은 것이 없으면 그냥 빈 응답만 돌아온다(비용 없음).
-- =============================================================================

create or replace function public.run_photo_vision_chunk()
returns text
language plpgsql
security definer
set search_path = ''
as $photo_vision_chunk$
begin
  -- 앞 작업이 아직 돌고 있으면 건너뛴다 — job-tag-chunk(026)와 같은 이유다.
  -- 비전 분석은 한 보고서에 사진이 여러 장이면 시간이 꽤 걸릴 수 있어
  -- 1분 주기와 겹칠 가능성이 코드 부여보다 오히려 높다.
  if exists (
    select 1 from public.job_run
    where job = 'photo-vision' and settled_at is null
      and started_at > now() - interval '5 minutes'
  ) then
    return '앞 작업이 진행 중 — 건너뜀';
  end if;

  perform public.run_job('photo-vision');
  return '요청함';
end;
$photo_vision_chunk$;

create or replace function public.set_photo_vision(p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $set_photo_vision$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'job-photo-vision';
  if v_jobid is null then
    raise exception 'job-photo-vision 작업이 등록돼 있지 않습니다.';
  end if;
  perform cron.alter_job(v_jobid, active := p_on);
  return p_on;
end;
$set_photo_vision$;

create or replace function public.photo_vision_on()
returns boolean
language sql
stable
security definer
set search_path = ''
as $is_on$
  select coalesce((select active from cron.job where jobname = 'job-photo-vision'), false);
$is_on$;

revoke execute on function public.run_photo_vision_chunk()     from public;
revoke execute on function public.set_photo_vision(boolean)    from public;
revoke execute on function public.photo_vision_on()            from public;
revoke execute on function public.run_photo_vision_chunk()     from anon, authenticated;
revoke execute on function public.set_photo_vision(boolean)    from anon, authenticated;
revoke execute on function public.photo_vision_on()            from anon, authenticated;

-- 1분마다. 등록만 해 두고 꺼 둔다 — 켜는 것은 담당자다.
select cron.unschedule('job-photo-vision')
where exists (select 1 from cron.job where jobname = 'job-photo-vision');

select cron.schedule('job-photo-vision', '* * * * *', $job$select public.run_photo_vision_chunk()$job$);
select public.set_photo_vision(false);
