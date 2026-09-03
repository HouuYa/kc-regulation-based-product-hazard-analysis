-- =============================================================================
-- 정기 작업을 짧은 구간으로 실행
--
-- 025 의 하루 한 번 전체 실행은 Netlify 의 HTTP 프록시 제한(약 30초)을
-- 넘길 수 있었다. 한 요청이 전체 자료를 처리하지 않고, 20건씩 별도 요청으로
-- 처리하도록 바꾼다. 각 요청의 결과는 기존 job_run 장부에 따로 남는다.
--
-- 리콜 승인 자료는 현재 2,252건이므로 10건 구간 500개(최대 5,000건)를
-- 5분마다 순환한다. 새 자료가 끝에 추가되는 정렬 방식이라 다음 순환에서
-- 자연스럽게 반영된다. 기준 JSON은 현재 76개이므로 20분마다 4개 구간을 순환한다.
-- =============================================================================

create or replace function public.run_recall_batch()
returns text
language plpgsql
security definer
set search_path = ''
as $run_recall_batch$
declare
  v_offset int;
begin
  v_offset := (floor(extract(epoch from now()) / 300)::int % 500) * 10;
  perform public.run_job_at(
    'recalls-fetch',
    'offset=' || v_offset || '&limit=10'
  );
  return format('리콜 구간 요청 offset=%s limit=10', v_offset);
end;
$run_recall_batch$;

create or replace function public.run_standards_batch()
returns text
language plpgsql
security definer
set search_path = ''
as $run_standards_batch$
declare
  v_offset int;
begin
  v_offset := (floor(extract(epoch from now()) / 300)::int % 76);
  perform public.run_job_at(
    'standards-sync',
    'offset=' || v_offset || '&limit=1'
  );
  return format('기준 구간 요청 offset=%s limit=1', v_offset);
end;
$run_standards_batch$;

revoke execute on function public.run_recall_batch() from public;
revoke execute on function public.run_standards_batch() from public;

select cron.unschedule('job-recalls-fetch')
where exists (select 1 from cron.job where jobname = 'job-recalls-fetch');
select cron.unschedule('job-standards-sync')
where exists (select 1 from cron.job where jobname = 'job-standards-sync');

-- 5분마다 다음 리콜 구간 하나 실행. 전체 순환은 약 42시간이다.
select cron.schedule('job-recalls-fetch', '*/5 * * * *', $job$select public.run_recall_batch()$job$);
-- 5분마다 다음 기준 파일 하나 실행. 전체 순환은 약 6시간 20분이다.
select cron.schedule('job-standards-sync', '*/5 * * * *', $job$select public.run_standards_batch()$job$);