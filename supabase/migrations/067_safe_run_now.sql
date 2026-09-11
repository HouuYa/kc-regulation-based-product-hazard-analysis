-- =============================================================================
-- "지금 실행" 버튼이 옛 방식(run_job)을 써서 리콜 수집을 부르면 항상 504가 난다
--
-- 무엇이 문제였나 (2026-09-11 텔레그램 알림으로 발견)
--   /ops 화면의 "지금 실행" 버튼(src/app/ops/actions.ts runJobNow)은 025에서
--   만든 run_job(text)를 그대로 쓴다. 인자가 없으므로 /api/jobs/recalls-fetch가
--   기본값 limit=20으로 돈다.
--
--   그런데 033·034에서 실측으로 밝혀진 값은 "4,100ms + 건당 2,875~4,617ms,
--   제한은 약 30초"다. limit=20이면 4,100 + 2,875×20 ≈ 61,600ms — 항상 제한을
--   넘긴다. 정기 실행(cron)은 028·033·034를 거치며 run_recall_batch()가
--   limit=3으로 안전하게 고쳐졌는데, 같은 화면의 수동 버튼은 그때 함께
--   고쳐지지 않고 옛 경로에 남아 있었다.
--
--   job_run을 조사해 보니 이번에 알림이 온 세 번(504×2·502×1) 모두 query가
--   null이었다 — 즉 cron이 아니라 이 버튼이 눌렸을 때였다. cron 쪽(query가
--   있는 호출)은 같은 4시간 동안 117건 모두 성공했다.
--
-- 고치는 방법
--   run_job_now(p_job)을 새로 만들어, recalls-fetch는 cron과 똑같이 limit=3으로
--   run_job_at을 거치게 한다. standards-sync는 이 기간 실패 사례가 없어(033의
--   측정에서도 50/52 성공) 건드리지 않고 기본값 그대로 둔다 — 고장 안 난 것을
--   고치지 않는다(CLAUDE.md §3).
--
--   run_job(text) 자체는 지우지 않는다. SQL 콘솔에서 직접 부를 일이 남아 있을
--   수 있고, 지금 문제는 "누가 인자 없이 불렀는가"이지 함수 자체의 결함이
--   아니다 — 호출부(actions.ts)만 안전한 함수로 바꾼다.
-- =============================================================================

create or replace function public.run_job_now(p_job text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $run_job_now$
declare
  v_query text;
begin
  -- recalls-fetch만 배치 크기를 강제한다 — 034가 실측으로 정한 값과 같다.
  -- 다른 작업은 이 기간 실패 사례가 없어 기본값(라우트의 limit=20)을 그대로 쓴다.
  if p_job = 'recalls-fetch' then
    v_query := 'limit=3';
  else
    v_query := null;
  end if;

  return public.run_job_at(p_job, v_query);
end;
$run_job_now$;

comment on function public.run_job_now(text) is
  '/ops 화면 "지금 실행" 버튼 전용. recalls-fetch는 034가 실측으로 정한 안전한 구간(limit=3)을 강제해 034 이전처럼 504로 항상 실패하는 것을 막는다';

revoke execute on function public.run_job_now(text) from public;
revoke execute on function public.run_job_now(text) from anon, authenticated;
