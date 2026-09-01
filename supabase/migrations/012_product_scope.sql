-- =============================================================================
-- 품목과 적용기준 (v0.7 §3.2 · §5.1)
--
-- v0.7 이 "필수 수정" 1순위로 지목한 공백이다.
--   "품목 범위가 확정되기 전에 모든 안전기준 조항을 검색해 다른 품목의 시험이
--    섞일 수 있다."
--   "품목별 부속서, 공통안전기준, 인용표준을 적용기준 세트로 묶는다."
--
-- 왜 item_name 문자열 비교로는 부족한가 (실측)
--   사고보고서 5건의 품목은 보조배터리·LED등기구·스팀다리미·가습기 —
--   전부 전기용품이다. 그런데 item_name 이 채워진 기준 33건은 전부 어린이제품이고,
--   KC 60335 계열 43건은 item_name 이 비어 있다(파일명에 품목이 없어서다).
--   문자열 비교만 하면 이 사고들은 영영 SCOPE_UNRESOLVED 다.
--
--   반면 각 기준의 "적용범위" 조항은 무엇을 다루는지 정확히 적고 있다.
--     KC 60335-2-13  "요리할 때 식용유를 사용하는 가정용 전기 튀김기, 전기 프라이팬"
--     K 60335-2-85   "직물용 전기 스티머(fabric steamers)"
--   그래서 적용범위 원문을 기준에 모아 두고 한국어 전문검색으로 찾는다.
--   근거가 원문이므로 "왜 이 기준이 적용되는가"를 담당자에게 문장으로 보일 수 있다.
--
-- 어린이제품은 부속서만으로 부족하다
--   유아용 의자 사고라면 부속서 8 과 공통안전기준을 함께 봐야 한다.
--   그 관계를 standard_applicability 의 COMMON 으로 명시한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 기준이 무엇을 다루는가 — 적용범위 원문 모음
-- -----------------------------------------------------------------------------
alter table public.standard
  add column if not exists scope_text text;

comment on column public.standard.scope_text is
  '적용범위(SCOPE) 조항 본문을 모은 것. 품목→기준 확정의 근거이자 담당자에게 보일 문장';

create index if not exists standard_scope_pgroonga_idx
  on public.standard using pgroonga (scope_text);

-- -----------------------------------------------------------------------------
-- 품목
-- -----------------------------------------------------------------------------
create table if not exists public.product_scope (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  /** 사고보고서가 쓰는 다른 이름들 — "보조배터리"·"전지"·"리튬이온배터리" */
  aliases     text[] not null default '{}',
  category    text check (category in ('어린이제품', '전기용품', '생활용품', '기타')),
  /** OECD GlobalRecalls 연계용 (PDR 부록 F). 지금은 비어 있어도 된다 */
  gpc_brick   text,
  note        text,
  created_at  timestamptz not null default now()
);

comment on table public.product_scope is
  '분석 대상 품목. 사고·리콜의 품목을 여기에 맞춘 뒤에야 기준 범위가 확정된다(v0.7 3.2)';
comment on column public.product_scope.aliases is
  '사고보고서 표기 흔들림을 흡수한다. 보고서는 "전지"라 쓰고 기준은 "보조배터리"라 쓴다';

create index if not exists product_scope_aliases_gin on public.product_scope using gin (aliases);

-- -----------------------------------------------------------------------------
-- 품목 ↔ 적용기준
-- -----------------------------------------------------------------------------
create table if not exists public.standard_applicability (
  id                bigint generated always as identity primary key,
  product_scope_id  bigint not null references public.product_scope(id) on delete cascade,
  standard_id       bigint not null references public.standard(id) on delete cascade,
  /**
   * ANNEX  이 품목의 고유 부속서 — 주 적용기준
   * COMMON 공통안전기준 — 부속서와 함께 적용된다
   * CITED  인용표준 — 부속서가 시험방법을 넘기는 다른 기준
   */
  relation          text not null check (relation in ('ANNEX', 'COMMON', 'CITED')),
  /** 어떻게 이 관계를 정했는가. 자동 판정이면 근거 문장을 남긴다 */
  evidence          text,
  confirmed_by      text,
  created_at        timestamptz not null default now(),
  unique (product_scope_id, standard_id, relation)
);

comment on table public.standard_applicability is
  '품목에 적용되는 기준 세트. 유아용 의자면 부속서 8(ANNEX) + 공통안전기준(COMMON) 둘 다다';

create index if not exists applicability_scope_idx    on public.standard_applicability (product_scope_id);
create index if not exists applicability_standard_idx on public.standard_applicability (standard_id);

-- -----------------------------------------------------------------------------
-- 사건이 어떤 품목으로 확정됐는가
--
-- 확정 자체를 사건에 기록한다. 확정하지 못하면 NULL 로 두고 분석을 막는다 —
-- v0.7 §3.2: "품목이 불명확하면 전 품목 검색을 자동 실행하지 않고
-- SCOPE_UNRESOLVED 로 보낸다."
-- -----------------------------------------------------------------------------
alter table public.case_event
  add column if not exists product_scope_id bigint references public.product_scope(id),
  add column if not exists scope_evidence   text,
  /** 사건 분석에 적용할 기준 시점 (v0.7 §5.4). 사고일과 분석일이 다르기 때문 */
  add column if not exists basis_date       date;

comment on column public.case_event.product_scope_id is
  'NULL 이면 품목 미확정 — 분석을 실행하지 않는다(v0.7 3.2 SCOPE_UNRESOLVED)';
comment on column public.case_event.scope_evidence is
  '왜 이 품목으로 봤는가. 적용범위 원문 구절이나 담당자 메모';
comment on column public.case_event.basis_date is
  '적용 기준일. 제조·유통·사고 중 무엇을 볼지는 담당자가 정하고 근거를 남긴다(v0.7 5.4)';

create index if not exists case_event_scope_idx on public.case_event (product_scope_id);

alter table public.product_scope          enable row level security;
alter table public.standard_applicability enable row level security;
