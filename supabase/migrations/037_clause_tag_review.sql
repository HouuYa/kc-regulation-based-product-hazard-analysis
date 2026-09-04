-- =============================================================================
-- 조항 태그 검수 — 지금까지 확정할 방법이 아예 없었다
--
-- 무엇이 비어 있었나 (2026-09-04 확인)
--   clause_tag.review_status 는 003 부터 있었고 기본값이 'auto_unreviewed' 다.
--   그런데 저장소 전체를 훑어보니 이 값을 **바꾸는 코드가 한 줄도 없다.**
--   전부 읽기뿐이다. 세어 보니 조항 태그 1,855건이 100% auto_unreviewed 였다.
--
--   그 결과로 세 가지가 동시에 죽어 있었다.
--
--     1. 근거등급 A  match.ts 의 evidenceLevelOf() 는 승인 태그가 있을 때만 A 를
--                    준다. 승인이 0건이므로 A 가 나올 수 없다 — 등급 체계의 최상단이
--                    쓰이지 않는 칸이었다.
--     2. 030 의 스위치  검색을 검수 확정분으로 좁히는 인자를 만들어 두었는데,
--                    켜면 코드 근거가 전부 사라진다. 승인할 방법이 없으니 영원히 그렇다.
--     3. 3번째 산출물  "담당자가 검토한 기록"을 집계 재료로 삼는데 그 기록이 안 쌓인다.
--
--   설계문서가 §3.3 에서 "사람이 검수 확정한 태깅은 자동 재태깅으로 덮어쓰지 않는다"고
--   적어 둔 것도, 확정할 길이 없으면 지킬 것이 없는 약속이다.
--
-- 무엇을 더하는가
--   검수 이력 표 하나. clause_tag 의 review_status 를 바꾼 사실을 그대로 남긴다.
--
-- 왜 이력을 따로 쌓는가 (원 계획서 P0)
--   clause_tag 자체에도 reviewed_by·reviewed_at 이 있지만 그것은 "마지막 상태"다.
--   무엇을 무엇으로 바꿨는지, 왜 그랬는지는 덮어써진다. 이 체계에서 가장 값나가는
--   자산이 담당자의 판단인데(§10 특이관점), 판단의 이력이 남지 않으면 나중에
--   "그때 왜 이렇게 정했는가"를 되짚을 수 없다. review_log 가 분석 후보에 대해
--   하는 일을 조항 태그에 대해서도 한다.
--
-- 근거 문구가 코드별로 나뉘어 있지 않다는 것 (알면서 이번에 안 고친 것)
--   지금은 조항 하나의 evidence_span 을 그 조항의 모든 코드가 함께 쓴다
--   (tag-run.ts). 원 계획서는 코드별로 나누자고 했는데, 그러려면 태깅 프롬프트가
--   코드마다 근거를 따로 돌려주게 고쳐야 한다. 프롬프트 변경은 이번 범위 밖이므로
--   (02 설계서 §8), 검수 화면에 "이 근거는 조항 전체에 대한 것"이라고 밝혀 둔다.
--   검수자가 코드별 근거로 오해하면 안 되기 때문이다.
-- =============================================================================

create table if not exists public.clause_tag_review (
  id            bigint generated always as identity primary key,
  clause_tag_id bigint not null references public.clause_tag(id) on delete cascade,

  -- 무엇에서 무엇으로 바꿨는가
  from_status   text not null,
  to_status     text not null check (to_status in ('approved', 'rejected', 'modified')),

  -- 왜 그랬는가. 반려는 집계할 수 있게 선택지로 받는다(review_log 와 같은 이유)
  reject_reason text check (reject_reason in (
                  'NOT_A_REQUIREMENT',   -- 요건 조항이 아님(정의·적용범위 등)
                  'WRONG_CODE',          -- 코드가 맞지 않음
                  'NO_EVIDENCE',         -- 근거 문구가 이 코드를 뒷받침하지 않음
                  'TOO_BROAD'            -- 지나치게 넓은 코드
                )),
  note          text,
  reviewer      text,

  -- 그때 무엇을 보고 판단했는가. 코드북이나 태깅 판이 바뀌면 같은 판단이
  -- 더 이상 유효하지 않을 수 있다
  codebook_version text,
  tagging_version  text,

  created_at    timestamptz not null default now(),

  -- 반려인데 사유가 없으면 집계에서 빈칸이 된다. 처음부터 막는다(review_log 와 동일)
  constraint clause_tag_review_reason_required
    check (to_status <> 'rejected' or reject_reason is not null)
);

comment on table  public.clause_tag_review        is '조항 태그 검수 이력. 마지막 상태가 아니라 바꾼 사실을 쌓는다';
comment on column public.clause_tag_review.reject_reason is '집계 가능한 선택지로 받는다. 자유 텍스트만 받으면 나중에 집계가 안 된다(7.2)';
comment on column public.clause_tag_review.codebook_version is '그때 본 코드북 판. 판이 바뀌면 판단을 다시 봐야 할 수 있다';

create index if not exists clause_tag_review_tag_idx on public.clause_tag_review (clause_tag_id, created_at desc);
create index if not exists clause_tag_review_when_idx on public.clause_tag_review (created_at desc);

alter table public.clause_tag_review enable row level security;
revoke all on table public.clause_tag_review from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 검수 한 번을 한 트랜잭션으로
--
-- 상태 변경과 이력 기록이 따로 나가면, 중간에 끊겼을 때 "바뀌었는데 왜 바뀌었는지
-- 모르는" 행이 남는다. 판단 기록이 이 체계의 자산인데 그 자산만 빠지는 셈이다.
--
-- 조항 단위로 받는 이유: 검수자는 조항을 읽고 판단한다. 코드 하나씩 누르게 하면
-- 같은 조항 본문을 여러 번 읽어야 하고, 그러면 뒤로 갈수록 대충 누르게 된다.
-- -----------------------------------------------------------------------------
create or replace function public.review_clause_tags(
  p_clause_id     bigint,
  p_to_status     text,
  p_reviewer      text default null,
  p_reject_reason text default null,
  p_note          text default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $review$
declare
  v_n int := 0;
  r   record;
begin
  if p_to_status not in ('approved', 'rejected', 'modified') then
    raise exception '알 수 없는 검수 상태: %', p_to_status;
  end if;
  if p_to_status = 'rejected' and p_reject_reason is null then
    raise exception '반려에는 사유가 필요합니다';
  end if;

  for r in
    select id, review_status, codebook_version, tagging_version
    from public.clause_tag
    where clause_id = p_clause_id
      -- 이미 같은 상태면 건드리지 않는다. 이력에 뜻 없는 행이 쌓인다
      and review_status is distinct from p_to_status
  loop
    insert into public.clause_tag_review
      (clause_tag_id, from_status, to_status, reject_reason, note, reviewer,
       codebook_version, tagging_version)
    values
      (r.id, r.review_status, p_to_status, p_reject_reason, p_note, p_reviewer,
       r.codebook_version, r.tagging_version);

    update public.clause_tag
    set review_status = p_to_status,
        reviewed_by   = p_reviewer,
        reviewed_at   = now()
    where id = r.id;

    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$review$;

comment on function public.review_clause_tags(bigint, text, text, text, text) is
  '조항 하나의 태그 전체를 한 번에 검수하고 이력을 남긴다. 바뀐 태그 수를 돌려준다';

revoke execute on function public.review_clause_tags(bigint, text, text, text, text) from public;
revoke execute on function public.review_clause_tags(bigint, text, text, text, text) from anon, authenticated;
