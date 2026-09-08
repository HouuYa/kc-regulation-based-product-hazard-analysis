/*
  「아직 안 돌렸다」와 「돌렸지만 브릭까지 못 좁혔다」를 구별한다 (061)

  담당자가 "종아리마사지기가 GPC에 없다는 것이 이상하다"고 물었을 때, 확인해 보니
  분류기가 틀린 게 아니라 한 번도 돌린 적이 없었다. 그래서 화면 문구를 「아직 배정
  안 함」으로 고쳤다(라운드 58).

  이제 실제로 돌린다. 그런데 지금 표는 브릭 코드가 필수라, 돌렸는데 브릭까지
  좁히지 못한 품목은 행 자체를 만들 수 없다. 그러면 화면은 여전히 「아직 안 함」이라고
  말하게 된다 — 처음과 똑같은 잘못을 반복하는 셈이다.

  그래서 셋을 구별할 수 있게 고친다.
    행이 없다                    아직 안 돌렸다
    행이 있고 brick_code 가 null  돌렸으나 브릭까지 못 좁혔다(세그먼트·패밀리·클래스 또는 없음)
    행이 있고 brick_code 가 있다   붙었다

  source 에 'LLM' 을 더한다 — 지금까지는 담당자 엑셀(EXPERT)과 적용범위 의미검색
  (SEMANTIC) 둘뿐이었는데, 이번 배정은 GPC 브릭 임베딩으로 후보를 좁힌 뒤 LLM 이
  고르는 방식이라 둘 중 어느 것도 아니다. 출처가 다르면 믿을 근거도 다르므로 나눈다.
*/

alter table public.scope_term_gpc
  alter column brick_code drop not null;

alter table public.scope_term_gpc
  drop constraint if exists scope_term_gpc_source_check;

alter table public.scope_term_gpc
  add constraint scope_term_gpc_source_check
    check (source in ('EXPERT', 'SEMANTIC', 'LLM'));

alter table public.scope_term_gpc
  add column if not exists verified_level text
    check (verified_level in ('BRICK', 'CLASS', 'FAMILY', 'SEGMENT', 'NONE')),
  add column if not exists checked_at timestamptz;

comment on column public.scope_term_gpc.brick_code is
  '브릭 코드. null 이면 배정을 돌렸으나 브릭까지 좁히지 못한 것이다 — 행이 아예 없는 것(아직 안 돌림)과 다르다(061)';
comment on column public.scope_term_gpc.verified_level is
  '어느 계위까지 좁혔는가 — BRICK 이 가장 아래다. CLASS·FAMILY·SEGMENT 는 그 위에서 멈춘 것, NONE 은 맞는 것이 없다고 판단한 것';
comment on column public.scope_term_gpc.checked_at is
  '배정을 돌린 시각. 이 값이 있으면 「아직 안 함」이 아니다';

-- 담당자 엑셀에서 온 기존 33건은 사람이 정한 것이므로 브릭 계위로 확정된 것이다
update public.scope_term_gpc
set verified_level = 'BRICK'
where brick_code is not null and verified_level is null;
