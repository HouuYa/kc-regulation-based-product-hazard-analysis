-- =============================================================================
-- 품목 용어 사전 — 법령 용어와 일상 용어의 간극을 자료로 메운다
--
-- 무엇이 문제인가 (실측)
--   기준의 적용범위는 법령 용어를 쓰고, 사고보고서는 일상 용어를 쓴다.
--
--     전기요       ← KC 60335-2-17 은 "전기 담요, 패드들, 의류" 라고 쓴다
--     전기레인지    ← KC 60335-2-6 은 "거치형 조리레인지, 호브, 오븐" 이라고 쓴다
--     전동킥보드    ← 부속서 72 는 "전동이륜평행차, 전동외륜보드" 라고 쓴다
--     모발건조기    ← KC 60335-2-23 은 "피부 또는 모발을 손질하기 위한 기기" 라고 쓴다
--
--   글자를 맞추는 방법으로는 넘을 수 없다. 사고보고서 70건에서 품목이 붙은 것이
--   7건(10%)뿐이었던 이유가 이것이다.
--
--   설계문서 §5.2.1 이 조항 검색에서 지목한 간극("기준은 전도, 사고는 넘어짐")과
--   같은 문제이고, 담당자 말대로 "이런 것들이 많이 있다".
--
-- 왜 사전인가 — 의미 검색만으로는 부족하다
--   적용범위를 임베딩해 견주고 모델이 고르게 하니 10건 중 8건을 맞혔다. 크게
--   나아졌지만 두 가지가 남는다.
--
--     1. 매번 AI 를 부른다. 같은 "전기요"를 볼 때마다 다시 묻는다
--     2. 모델이 흔들리면 결과가 흔들린다. 같은 품목에 다른 기준이 붙을 수 있다
--
--   한 번 정해진 대응은 지식이다. 지식은 저장해야 한다. 그래야 다음부터는
--   공짜이고, 항상 같고, 사람이 고칠 수 있다.
--
-- 어디서 채우는가
--   1) 담당자가 사고조사에서 정한 것 (source='EXPERT')
--      __사고조사 건별 결함조사 항목 목록화 엑셀이 품목 34종의 대응을 준다.
--      사람이 실제 사고를 조사하며 정한 것이라 가장 믿을 만하다.
--   2) 의미 검색이 찾아낸 것 (source='SEMANTIC', review_status='auto_unreviewed')
--      담당자가 확인하면 확정된다. 확인 전에는 참고로만 쓴다.
--
--   이 표가 이 체계의 성격을 그대로 보여 준다 — 판단이 쌓여 자산이 된다(§10).
--
-- 무엇을 하지 않는가
--   자동으로 확정하지 않는다. 의미 검색이 넣은 행은 미검수로 남고, 그 사실이
--   화면과 근거에 그대로 표시된다. 틀린 품목은 안 붙인 것보다 나쁘다 —
--   다른 제품의 시험이 섞인 목록을 담당자가 근거로 쓰게 되기 때문이다.
-- =============================================================================

create table if not exists public.scope_term (
  id            bigint generated always as identity primary key,

  -- 일상 용어. 사고보고서·리콜에 적히는 말 그대로
  term          text   not null,
  -- 비교용으로 다듬은 형태(공백·괄호 제거, 소문자). 조회는 이것으로 한다
  term_key      text   not null,

  standard_id   bigint not null references public.standard(id) on delete cascade,

  source        text   not null check (source in ('EXPERT', 'SEMANTIC')),
  -- 왜 이 대응인가. 사람이 읽고 판단할 수 있어야 한다
  evidence      text,
  confidence    numeric check (confidence between 0 and 1),

  review_status text   not null default 'auto_unreviewed'
                  check (review_status in ('auto_unreviewed', 'approved', 'rejected')),
  reviewed_by   text,
  reviewed_at   timestamptz,

  created_at    timestamptz not null default now(),

  -- 같은 말에 같은 기준을 두 번 넣지 않는다
  unique (term_key, standard_id)
);

comment on table  public.scope_term is
  '일상 용어 → 적용 기준 사전. 법령 용어와 일상 용어의 간극을 자료로 메운다';
comment on column public.scope_term.term_key is
  '조회용으로 다듬은 형태. "LED 등기구"와 "LED등기구"가 같은 것으로 잡히게 한다';
comment on column public.scope_term.source is
  'EXPERT=담당자가 사고조사에서 정한 것 / SEMANTIC=의미 검색이 찾은 것(검수 필요)';

create index if not exists scope_term_key_idx on public.scope_term (term_key)
  where review_status <> 'rejected';

alter table public.scope_term enable row level security;
revoke all on table public.scope_term from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 조회용 함수 — 다듬는 규칙을 한 곳에 둔다
--
-- 애플리케이션과 SQL 이 각자 다듬으면 "LED 등기구"가 한쪽에서만 잡힌다.
-- -----------------------------------------------------------------------------
create or replace function public.scope_term_key(p_term text)
returns text
language sql
immutable
set search_path = ''
as $key$
  -- 괄호와 그 안, 공백·가운뎃점·붙임표를 없애고 소문자로 맞춘다.
  -- "(비대상) 후드믹서" → "후드믹서", "LED 등기구" → "led등기구"
  select lower(regexp_replace(
           regexp_replace(coalesce(p_term, ''), '\([^)]*\)', '', 'g'),
           '[[:space:]·\-_/]', '', 'g'));
$key$;

comment on function public.scope_term_key(text) is
  '용어를 조회용 형태로 다듬는다. 괄호·공백·구분기호를 없애고 소문자로 맞춘다';

revoke execute on function public.scope_term_key(text) from public;
revoke execute on function public.scope_term_key(text) from anon, authenticated;
