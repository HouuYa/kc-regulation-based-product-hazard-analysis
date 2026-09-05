-- =============================================================================
-- 법정 품목 계층 ↔ GPC 대응표
--
-- 무엇이 들어오나
--   협회가 준 「품목별 세분류 매칭 DB」 2,148행이다. 한 행이 이렇게 생겼다.
--
--     전기용품 · 안전인증 · 조명기기 > 램프홀더 > 에디슨 나사형 홀더
--       → 기타 램프 브래킷/피팅 (GPC 브릭 10005637)
--
--   법정 품목 123종 · 세부품목 412종 · 세세부품목 623종 · GPC 브릭 764종.
--
-- 왜 중요한가 (04 §5, 04-2 §1)
--   이 체계는 같은 물건을 네 가지 말로 부른다 — 사고보고서의 일상어, KC기준의
--   법정어, GPC 국제분류, 해외리콜의 번역어. 그중 **GPC 축이 통째로 끊겨 있었다.**
--   브릭 자료 5,318건을 갖춰 놓고도 사고 0건·리콜 0건이 붙어 있었다.
--
--   그 결과 사고와 리콜을 같은 품목군으로 묶을 키가 없어 3번째 산출물(사각지대
--   집계)이 막혀 있었다. 이 표가 그 다리다.
--
--   추정으로 잇는 것과 다르다. 소관부처가 정한 대응이라 근거가 확정적이다.
--   의미 검색이나 LLM 으로 GPC 를 붙이려던 계획(04-2 §4.3)은 이 표가 들어옴으로써
--   할 이유가 없어졌다.
--
-- 여전히 남는 것
--   이 표는 **법정어 ↔ GPC** 를 잇는다. **일상어 ↔ 법정어** 는 아니다.
--   사고보고서는 "LED등기구"라 적는데 이 표는 "조명기기 > 램프홀더"라 적는다.
--   그 한 겹은 scope_term 사전과 LLM 제안이 계속 메운다.
--
-- 원본을 그대로 담는다
--   행을 합치거나 다듬지 않는다. 협회가 개정판을 주면 통째로 다시 넣는 편이
--   맞고, 그러려면 원본과 같은 모양이어야 어디가 달라졌는지 볼 수 있다.
-- =============================================================================

create table if not exists public.product_taxonomy (
  id            bigint generated always as identity primary key,

  -- 법령 쪽
  ministry      text,
  law           text not null,
  item_group    text not null,   -- 생활용품 / 어린이제품 / 전기용품
  cert_scheme   text not null,   -- 안전인증 / 안전확인 / 공급자적합성확인 / 안전기준준수 / 안전성검사

  -- 법정 품목 계층
  item          text not null,
  sub_item      text,
  sub_sub_item  text,

  -- GPC 계층 (세분류 = 브릭)
  segment_code  text, segment_title text,
  family_code   text, family_title  text,
  class_code    text, class_title   text,
  brick_code    text not null, brick_title text,
  brick_definition text,
  brick_excludes   text,

  source_file   text not null,
  loaded_at     timestamptz not null default now()
);

comment on table public.product_taxonomy is
  '법정 품목 계층과 GPC 분류의 대응. 협회 「품목별 세분류 매칭 DB」 원본을 그대로 담는다';
comment on column public.product_taxonomy.cert_scheme is
  '안전관리 기준. standard.cert_scheme 과 같은 말이라 품목 → 기준을 좁히는 데 쓸 수 있다';
comment on column public.product_taxonomy.brick_code is
  'GPC 세분류(브릭) 코드. gpc_brick.brick_code 와 논리 참조한다 — 원본이 우리 브릭 목록보다 넓을 수 있어 FK 를 걸지 않는다';

-- 품목명으로 찾는 길. 법정 계층 세 칸을 모두 훑는다
create index if not exists product_taxonomy_item_idx
  on public.product_taxonomy (item);
create index if not exists product_taxonomy_sub_idx
  on public.product_taxonomy (sub_item);
create index if not exists product_taxonomy_subsub_idx
  on public.product_taxonomy (sub_sub_item);

-- GPC 로 되짚는 길. 사고·리콜에 브릭이 붙으면 이 표로 법정 품목을 되찾는다
create index if not exists product_taxonomy_brick_idx
  on public.product_taxonomy (brick_code);

-- 품목군·인증구분으로 좁히는 길
create index if not exists product_taxonomy_group_idx
  on public.product_taxonomy (item_group, cert_scheme);

alter table public.product_taxonomy enable row level security;
revoke all on table public.product_taxonomy from anon, authenticated;
