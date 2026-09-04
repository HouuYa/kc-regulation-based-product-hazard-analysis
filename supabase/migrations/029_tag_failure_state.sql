-- =============================================================================
-- 태깅 실패 조항이 대기줄 머리를 막는 문제 — 실패를 조항에 기록해 대상에서 뺀다
--
-- 무엇이 잘못돼 있었나 (02_1차 보완 및 구현 설계서 §3.1)
--   태깅에 실패한 조항은 clause_tag 에 아무것도 남기지 않는다. 그런데 대상 조회
--   조건이 "clause_tag 에 행이 없는 조항"이므로, 실패한 조항은 다음 차례에도
--   목록 맨 앞에 그대로 있다. 순서가 (standard_id, order_index) 로 고정이라
--   자리가 바뀌지도 않는다.
--
--   그 결과 세 가지가 동시에 일어난다.
--
--     1. offset=0 요청이 매 분 같은 조항부터 다시 시도한다. 실패가 열 건만 쌓여도
--        세 갈래 중 한 갈래는 종일 같은 조항만 붙들고 AI 를 부른다. 돈이 나간다.
--     2. countTaggable() 이 0 으로 내려가지 않는다.
--     3. run_tag_chunk() 의 v_left 도 0 이 되지 않으므로 자동 실행이 스스로
--        꺼지지 않고 완료 알림도 오지 않는다. 1분마다 영원히 돈다.
--
--   027 이 걱정한 "구간이 밀려 조항을 건너뛰는 것"은 다음 차례에 회수된다 —
--   앞의 것들이 처리될수록 밀린 조항이 목록 앞으로 당겨지기 때문이다.
--   그러나 이쪽은 회수되지 않고 비용만 쌓인다. 이것이 더 비싼 문제다.
--
-- 어떻게 고치는가
--   예약 장부를 새로 만들 필요는 없다. 실패를 조항 자신에게 적어 두고, 정해진
--   횟수를 넘기면 대상에서 빼면 된다. 표 하나와 컬럼 세 개로 끝난다.
--
-- 왜 한도가 3인가
--   태깅은 조항 하나에 AI 를 3~4회 부른다. 일시적인 요청 한도 초과라면 다음
--   차례에 성공한다. 세 번 연속 실패하는 것은 조항 자체나 프롬프트의 문제일
--   가능성이 높다 — 기계가 계속 두드릴 일이 아니라 사람이 봐야 할 일이다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 조항에 실패 이력을 적는다
--
-- 성공하면 0 으로 되돌리므로 "연속" 실패 횟수다. 어쩌다 한 번 실패한 조항이
-- 이력을 계속 지고 다니지 않게 하려는 것이다.
-- -----------------------------------------------------------------------------
alter table public.clause
  add column if not exists tag_fail_count int not null default 0,
  add column if not exists tag_last_error text,
  add column if not exists tag_failed_at  timestamptz;

comment on column public.clause.tag_fail_count is
  '연속 태깅 실패 횟수. 3 이상이면 자동 대상에서 뺀다. 성공하면 0 으로 되돌린다';
comment on column public.clause.tag_last_error is
  '마지막 실패 사유. 담당자가 원인을 보고 다시 시도할지 정한다';
comment on column public.clause.tag_failed_at is
  '마지막 실패 시각';

-- 대상 조회가 매번 이 컬럼으로 거르므로 색인을 둔다.
-- 부분 색인인 이유: 값이 0 인 행이 대부분이라 전체 색인은 이득이 없다.
create index if not exists clause_tag_failed_idx
  on public.clause (tag_fail_count)
  where tag_fail_count > 0;

-- -----------------------------------------------------------------------------
-- 자동 실행의 남은 건수 계산에도 같은 조건을 넣는다
--
-- 이것이 이 마이그레이션의 핵심이다. tag-run.ts 만 고치고 여기를 두면
-- "처리할 것이 없는데 v_left 는 0 이 아닌" 상태가 되어 자동 실행이 영원히 돈다.
-- 두 곳의 대상 정의가 반드시 같아야 한다.
--
-- 027 에서 바뀐 것은 v_left 조회의 조건 한 줄과 완료 알림 문구뿐이다.
-- 나머지(45초 겹침 방지, 세 갈래 분할)는 그대로 둔다 — 잘 돌고 있고
-- 이번 문제와 상관이 없다.
-- -----------------------------------------------------------------------------
create or replace function public.run_tag_chunk()
returns text
language plpgsql
security definer
set search_path = ''
as $tag_chunk$
declare
  v_left    int;
  v_stalled int;
  v_off     int;
begin
  -- 겹침 방지 — 45초 안에 보낸 것이 있으면 아직 도는 중이다(027)
  if exists (
    select 1 from public.job_run
    where job = 'tag-chunk' and started_at > now() - interval '45 seconds'
  ) then
    return '앞 작업이 진행 중 — 건너뜀';
  end if;

  select count(*)::int into v_left
  from public.clause c
  join public.standard s on s.id = c.standard_id
  where s.is_current and c.clause_role = 'REQUIREMENT'
    and length(btrim(c.body)) >= 15
    and c.tag_fail_count < 3
    and not exists (select 1 from public.clause_tag t where t.clause_id = c.id);

  if v_left = 0 then
    -- 포기한 것과 끝낸 것을 한 숫자로 뭉뚱그리지 않는다. 알림에도 따로 적는다 —
    -- "다 끝났다"는 말만 보고 담당자가 손을 떼면 실패분이 영원히 묻힌다.
    select count(*)::int into v_stalled
    from public.clause c
    join public.standard s on s.id = c.standard_id
    where s.is_current and c.clause_role = 'REQUIREMENT'
      and length(btrim(c.body)) >= 15
      and c.tag_fail_count >= 3
      and not exists (select 1 from public.clause_tag t where t.clause_id = c.id);

    perform public.set_auto_tagging(false);
    perform public.ops_notify(
      '코드 부여 완료',
      case when v_stalled = 0
        then E'모든 요건 조항에 위해요인 코드가 부여됐습니다.\n자동 실행은 스스로 껐습니다.'
        else format(
          E'남은 요건 조항을 모두 처리했습니다.\n다만 %s건은 세 번 연속 실패해 넘겼습니다 — 운영 화면에서 사유를 확인해 주세요.\n자동 실행은 스스로 껐습니다.',
          v_stalled)
      end,
      interval '0'
    );
    return format('남은 조항 없음 — 자동 실행을 껐습니다 (재시도 한도 초과 %s건)', v_stalled);
  end if;

  for v_off in
    select o from unnest(array[0, 40, 80]) as o where o < v_left
  loop
    perform public.run_job_at('tag-chunk', 'offset=' || v_off);
  end loop;

  return format('요청함 (남은 조항 %s건)', v_left);
end;
$tag_chunk$;

revoke execute on function public.run_tag_chunk() from public;

-- -----------------------------------------------------------------------------
-- 담당자가 포기한 조항을 다시 열 수 있게 한다
--
-- 원인이 일시적인 것(모델 장애, 요청 한도)이었다면 고친 뒤 다시 돌리면 된다.
-- 되돌릴 방법이 없으면 한 번 실패한 조항이 영영 처리되지 않는다.
-- -----------------------------------------------------------------------------
create or replace function public.reset_tag_failures(p_clause_id bigint default null)
returns int
language plpgsql
security definer
set search_path = ''
as $reset$
declare
  v_n int;
begin
  update public.clause
  set tag_fail_count = 0, tag_last_error = null, tag_failed_at = null
  where tag_fail_count > 0
    and (p_clause_id is null or id = p_clause_id);
  get diagnostics v_n = row_count;
  return v_n;
end;
$reset$;

comment on function public.reset_tag_failures(bigint) is
  '재시도 한도를 넘긴 조항을 다시 대상에 넣는다. 인자가 null 이면 전부';

revoke execute on function public.reset_tag_failures(bigint) from public;
revoke execute on function public.reset_tag_failures(bigint) from anon, authenticated;
