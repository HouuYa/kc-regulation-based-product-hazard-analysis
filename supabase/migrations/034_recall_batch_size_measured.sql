-- =============================================================================
-- 리콜 구간을 5건에서 3건으로 다시 낮춘다 — 한 번 재고 끝내지 않고 흩어짐까지 쟀다
--
-- 033 을 왜 다시 고치는가
--   033 은 limit=1~4 를 재서 `4,100 + 2,875 × 건수` 라는 직선을 얻고 5건(약
--   18,500ms)을 골랐다. 그런데 그 네 번은 오프셋 0·100 한 곳에서만 잰 것이었다.
--   5건으로 바꾼 뒤 여러 구간에서 다시 재 보니 흩어짐이 컸다.
--
--     offset=200    20,851ms
--     offset=700    20,052ms
--     offset=1400   27,186ms   ← 최악
--     offset=1900   19,930ms
--
--   최악이 27,186ms 다. 제한 30초까지 2.8초밖에 안 남는다. 게다가 관리자 코드가
--   코드북에 없어 AI 로 다시 분류하는 건이 섞이면(전체의 1.8%) 약 6초가 더 붙어
--   33,186ms — 제한을 넘긴다. 5건은 "대체로 되지만 가끔 죽는" 값이었다.
--
--   평균으로 고르면 안 된다는 것이 이번에 얻은 교훈이다. 이 작업은 실패해도
--   화면에 아무 표시가 없고 알림만 쌓이므로, 가끔 죽는 설정은 오래 방치된다.
--   실제로 52번 연속 실패하는 동안 아무도 몰랐다.
--
-- 왜 3건인가 — 최악값으로 계산한다
--   최악 구간의 건당 비용은 (27,186 - 4,100) / 5 = 약 4,617ms 다. 이 값으로 보면
--
--     3건  4,100 + 13,851 = 17,951ms   AI 1건 섞여도 23,951ms  ← 채택
--     4건  4,100 + 18,468 = 22,568ms   AI 1건 섞이면 28,568ms  (여유 1.4초)
--     5건  4,100 + 23,085 = 27,185ms   AI 1건 섞이면 33,185ms  (초과)
--
--   3건이면 최악에 AI 가 겹쳐도 24초로, 제한의 80% 안에 들어온다.
--
-- 한 바퀴가 느려지는 것을 주기로 벌충한다
--   3건씩이면 승인 자료 2,252건을 다 도는 데 751번이 필요하다. 구간 수를 800 으로
--   두면 오프셋 0~2,397 을 훑어 전부 덮는다. 다만 5분 간격이면 한 바퀴가 66.7시간이라
--   새 리콜이 들어와도 최대 사흘 뒤에야 잡힌다 — 정렬이 id 오름차순이라 새 자료는
--   맨 뒤에 붙기 때문이다.
--
--   그래서 주기를 2분으로 줄인다. 800 × 2분 = 26.7시간으로, 지금까지 문서에 적어
--   두었던 42시간보다 오히려 빠르다. 한 요청이 20초 안팎이므로 2분 간격에서
--   앞뒤가 겹치지 않는다.
--
-- 근본 해법은 여전히 증분 수집이다
--   바뀐 것이 없는 자료까지 26시간마다 다시 훑는 것 자체가 낭비다. `updated_at`
--   커서로 새 자료·바뀐 자료만 먼저 처리하는 것이 제대로 된 답이고 02 설계서에
--   P2 로 올라 있다. 이 파일은 "가끔 죽는 것"을 "안 죽는 것"으로 바꾸는 데까지만 한다.
-- =============================================================================

create or replace function public.run_recall_batch()
returns text
language plpgsql
security definer
set search_path = ''
as $run_recall_batch$
declare
  -- 실측 최악값 기준. 이 값을 올리려면 여러 구간에서 다시 재고,
  -- 평균이 아니라 최악값으로 판단한다. 위 주석의 표를 함께 갱신한다.
  c_limit constant int := 3;
  -- c_limit 을 곱한 값이 승인 자료 건수(약 2,252)보다 커야 한 바퀴가 완성된다
  c_slots constant int := 800;
  v_offset int;
begin
  -- 주기가 2분이므로 나눗셈의 분모도 120 이다. 여기가 cron 주기와 어긋나면
  -- 어떤 구간은 두 번 돌고 어떤 구간은 건너뛴다
  v_offset := (floor(extract(epoch from now()) / 120)::int % c_slots) * c_limit;
  perform public.run_job_at(
    'recalls-fetch',
    'offset=' || v_offset || '&limit=' || c_limit
  );
  return format('리콜 구간 요청 offset=%s limit=%s', v_offset, c_limit);
end;
$run_recall_batch$;

revoke execute on function public.run_recall_batch() from public;
revoke execute on function public.run_recall_batch() from anon, authenticated;

-- 2분마다 다음 구간 하나. 한 바퀴는 약 26.7시간이다.
select cron.unschedule('job-recalls-fetch')
where exists (select 1 from cron.job where jobname = 'job-recalls-fetch');

select cron.schedule('job-recalls-fetch', '*/2 * * * *', $job$select public.run_recall_batch()$job$);
