-- =============================================================================
-- 용어에 GPC 브릭을 함께 붙인다 — 용어가 두 축의 앵커가 된다
--
-- 왜 나누고 왜 다시 잇는가
--   042 는 "일상 용어 → KC 기준" 만 담았다. GPC 를 기준 선택에 쓸 수 없다는 것을
--   실측으로 확인했기 때문이다 — 한 브릭이 기준이 다른 품목 여러 종을 묶는다.
--
--     10000759 개인용 온열/마사지용품 (동력)
--       눈마사지기 · 손목마사지기 · 전기마사지기 · 전기방석 · 전기찜질기
--       → 이 다섯의 적용 기준이 서로 다르다
--
--   그렇다고 GPC 가 쓸모없는 것은 아니다. 쓸 자리가 다를 뿐이다.
--   해외 리콜은 영어로, 우리 사고는 한국어로 적힌다. 둘을 같은 품목군으로 세려면
--   언어에 독립적인 키가 있어야 하고, 그것이 GPC 브릭이다.
--
--   그래서 용어를 앵커로 두고 두 축을 함께 매단다.
--
--     용어 "전기요" ─┬→ 기준 KC 60335-2-17 + 부속서 1   (기준 선택)
--                    └→ GPC 10000759                    (집계 묶기)
--
--   담당자가 만든 엑셀이 품목 → GPC 브릭 대응 39쌍을 이미 주고 있고, 전부
--   BRICK 계위다. 사람이 정한 것이므로 그대로 쓴다.
--
-- 왜 별도 컬럼인가 (기준과 한 행에 두지 않는 이유)
--   한 용어에 기준은 여러 개일 수 있지만(KC 60335-1 + KC 60335-2-23),
--   GPC 브릭은 그 용어에 하나다. 기준마다 행이 있는 표에 브릭을 넣으면 같은 값이
--   여러 번 들어가고, 한쪽만 고치면 어긋난다.
--
--   그래서 브릭은 용어 단위로 따로 둔다. 042 의 scope_term 은 (용어, 기준) 짝이고,
--   이 표는 (용어) 하나에 대한 것이다.
-- =============================================================================

create table if not exists public.scope_term_gpc (
  term_key      text primary key,
  -- 사람이 읽을 원래 표기. term_key 는 다듬은 형태라 화면에 쓸 수 없다
  term          text   not null,

  brick_code    text   not null references public.gpc_brick(brick_code),

  source        text   not null check (source in ('EXPERT', 'SEMANTIC')),
  evidence      text,
  confidence    numeric check (confidence between 0 and 1),

  review_status text   not null default 'auto_unreviewed'
                  check (review_status in ('auto_unreviewed', 'approved', 'rejected')),
  reviewed_by   text,
  reviewed_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.scope_term_gpc is
  '일상 용어 → GPC 브릭. 사고와 리콜을 같은 품목군으로 묶는 데 쓴다(기준 선택 아님)';

create index if not exists scope_term_gpc_brick_idx on public.scope_term_gpc (brick_code);

alter table public.scope_term_gpc enable row level security;
revoke all on table public.scope_term_gpc from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 화면이 읽는 한 줄 요약
--
-- 용어 하나에 기준 여러 개와 브릭 하나가 걸리므로, 화면에서 매번 조립하면
-- 목록 한 쪽에 조회가 여러 번 나간다. 여기서 한 번에 만든다.
-- -----------------------------------------------------------------------------
create or replace view public.scope_term_view
with (security_invoker = true) as
select
  t.term_key,
  min(t.term)                                       as term,
  count(*)::int                                     as standard_count,
  array_agg(s.display_name order by s.display_name) as standards,
  array_agg(t.id order by s.display_name)           as term_ids,
  -- 하나라도 담당자가 확정한 것이 있으면 EXPERT 로 본다
  bool_or(t.source = 'EXPERT')                      as has_expert,
  count(*) filter (where t.review_status = 'auto_unreviewed')::int as unreviewed_count,
  max(t.created_at)                                 as created_at,
  g.brick_code,
  gb.brick_title_ko,
  gb.brick_title_en,
  g.review_status                                   as gpc_review_status
from public.scope_term t
join public.standard s on s.id = t.standard_id
left join public.scope_term_gpc g  on g.term_key = t.term_key
left join public.gpc_brick gb      on gb.brick_code = g.brick_code
where t.review_status <> 'rejected' and s.is_current
group by t.term_key, g.brick_code, gb.brick_title_ko, gb.brick_title_en, g.review_status;

comment on view public.scope_term_view is '용어 사전 화면이 읽는 한 줄 요약';

revoke all on public.scope_term_view from anon, authenticated;
