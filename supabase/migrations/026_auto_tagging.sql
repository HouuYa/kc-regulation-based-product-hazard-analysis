-- =============================================================================
-- 위해요인 코드 부여를 눌러 두면 끝까지 돌게 한다
--
-- 담당자 요청: "npm run tag 도 웹페이지에서 클릭하면 자동으로 돌리게 해줘"
--
-- 왜 라운드 19의 「조금 실행하기」로는 부족했나
--   그 버튼은 한 번 눌러 18초어치만 하고 멈췄다. 남은 5,884건을 그렇게 끝내려면
--   수천 번을 눌러야 한다 — 자동이 아니라 수동을 잘게 쪼갠 것에 지나지 않았다.
--
-- 두 가지를 고쳐서 "눌러 두면 끝난다"가 됐다
--   1) 동시 처리 (src/lib/standards/tag-run.ts)
--      실측 1건당 17.8초 → 4.75초 (동시 4건, 12건을 57초에 처리).
--      조항끼리는 서로를 참조하지 않고 저장도 건별 트랜잭션이라 안전하다.
--   2) 이 파일 — 1분마다 스스로 이어서 하는 작업
--      한 번에 다 하려 들면 서버리스 실행 시간 제한에 걸린다. 대신 1분마다
--      25초어치씩 하고, 다 될 때까지 저절로 이어진다. 담당자는 켜 두고 잊으면 된다.
--      실측 기준 5,884건이 약 9시간이므로 퇴근 전에 켜면 아침에 끝나 있다.
--
-- 왜 기본값이 꺼짐인가
--   돈이 든다(약 $13). 라운드 19에서 담당자가 "돈 안 드는 것만 자동"으로 정했고
--   그 결정은 그대로다 — 켜는 것은 사람이고, 켤 때 화면이 비용을 보여 준다.
--   다 끝나면 스스로 꺼지고 텔레그램으로 알린다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 앞 작업이 아직 돌고 있으면 건너뛴다
--
-- 코드 부여는 한 번에 25초가 걸리고 주기는 1분이라 보통은 겹치지 않는다.
-- 그래도 모델이 느려지는 날이 있으므로 확인한다 — 겹치면 같은 조항을 두 번
-- 보내 돈이 두 배로 나간다.
-- -----------------------------------------------------------------------------
create or replace function public.run_tag_chunk()
returns text
language plpgsql
security definer
set search_path = ''
as $tag_chunk$
declare
  v_left int;
begin
  if exists (
    select 1 from public.job_run
    where job = 'tag-chunk' and settled_at is null
      and started_at > now() - interval '5 minutes'
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

  perform public.run_job('tag-chunk');
  return format('요청함 (남은 조항 %s건)', v_left);
end;
$tag_chunk$;

-- -----------------------------------------------------------------------------
-- 켜고 끄기 — 화면의 스위치가 이 함수를 부른다
--
-- 별도 설정 표를 만들지 않고 cron 작업 자체를 켜고 끈다. 상태가 한 군데에만
-- 있어야 "화면은 켜졌다는데 실제로는 안 도는" 어긋남이 생기지 않는다.
-- -----------------------------------------------------------------------------
create or replace function public.set_auto_tagging(p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $set_auto$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'job-tag-chunk';
  if v_jobid is null then
    raise exception 'job-tag-chunk 작업이 등록돼 있지 않습니다.';
  end if;
  perform cron.alter_job(v_jobid, active := p_on);
  return p_on;
end;
$set_auto$;

create or replace function public.auto_tagging_on()
returns boolean
language sql
stable
security definer
set search_path = ''
as $is_on$
  select coalesce((select active from cron.job where jobname = 'job-tag-chunk'), false);
$is_on$;

revoke execute on function public.run_tag_chunk()          from public;
revoke execute on function public.set_auto_tagging(boolean) from public;
revoke execute on function public.auto_tagging_on()         from public;

-- -----------------------------------------------------------------------------
-- 1분마다. 등록만 해 두고 꺼 둔다 — 켜는 것은 담당자다.
-- -----------------------------------------------------------------------------
select cron.unschedule('job-tag-chunk')
where exists (select 1 from cron.job where jobname = 'job-tag-chunk');

select cron.schedule('job-tag-chunk', '* * * * *', $job$select public.run_tag_chunk()$job$);
select public.set_auto_tagging(false);
