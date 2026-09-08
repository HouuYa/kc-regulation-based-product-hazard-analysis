/*
  「대분류」와 「인증구분」을 따로 둔다 (058) — 담당자 지적

  "전기용품·생활용품·어린이제품 등과, 안전확인·안전인증·공급자적합성확인·
   안전기준준수·안전성검사(폐배터리) 등은 별개의 결이다. 따로 구분 필요."

  맞다. 두 축이다.
    대분류(item_group)  어느 법의 어느 품목군인가 — 전기용품 · 생활용품 · 어린이제품
    인증구분(cert_type) 시장에 내보내기 전에 무엇을 거쳐야 하는가 —
                        안전인증 · 안전확인 · 공급자적합성확인 · 안전기준준수 · 안전성검사

  지금까지 standard.cert_scheme 한 칸에 이 둘이 섞여 있었다. 파일명에서 뽑는
  칸이라 「안전확인 부속서 6(완구)」에서는 인증구분이, 「KC 60335-2-15」처럼
  번호뿐인 파일에서는 대분류('전기용품')가 들어갔다. 축이 다른 값이 한 칸에
  있으니 이 칸으로는 대분류로 정렬할 수도, 인증구분으로 셀 수도 없다.

  057 은 이것을 뷰에서 임시로 계산했다. 이 파일이 그 계산을 진짜 칸으로 옮긴다 —
  뷰 안에만 있으면 담당자가 틀린 것을 고칠 수가 없기 때문이다.

  근거 자료
    docs/제품안전법제도/안전기준목록조사 취합(전기 생활 어린이).xlsx 를 옮겨 놓은
    public.product_taxonomy 에 두 축이 이미 따로 있다(item_group · cert_scheme).
    실측(2026-09-09) 1,148행: 전기용품 853 · 어린이제품 837 · 생활용품 458 조합 중
    인증구분은 안전인증 305 · 안전확인 719 · 공급자적합성확인 807 · 안전기준준수 313 ·
    안전성검사 4. 담당자가 말한 「안전성검사(폐배터리)」가 전기용품 4행으로 들어 있다.

  인증구분이 왜 배열인가
    인증구분은 기준이 아니라 품목에 붙는다. 전기용품 계열 기준 하나(KC 62368-1)는
    안전인증 품목과 공급자적합성확인 품목에 함께 걸린다. 하나만 적으면 거짓이 된다.
    반대로 부속서 계열은 문서 이름 자체가 인증구분이므로("안전확인 부속서 6") 한 개다.

  cert_scheme 은 지우지 않는다
    파일명이 무엇이라고 했는지의 기록이고, 적재기(src/lib/standards/load.ts)가
    아직 그 칸에 쓴다. 뜻만 「파일명에서 읽은 문자열」로 좁히고, 판단에는 쓰지 않는다.
*/

alter table public.standard
  add column if not exists item_group        text,
  add column if not exists item_group_source text,
  add column if not exists cert_types        text[],
  add column if not exists cert_type_source  text;

comment on column public.standard.cert_scheme is
  '파일명에서 읽은 문자열. 인증구분과 대분류가 섞여 있다(058 이전의 유산) — 판단에는 item_group / cert_types 를 쓴다';
comment on column public.standard.item_group is
  '대분류 — 전기용품 · 생활용품 · 어린이제품 · 기타. 정렬과 검수 묶음의 기준';
comment on column public.standard.item_group_source is
  '대분류를 정한 근거 — TAXONOMY(품목표 대응) · SCHEME(인증구분에서 추정) · NAME(이름에서 추정) · MANUAL(사람이 고침)';
comment on column public.standard.cert_types is
  '이 기준이 걸리는 품목의 인증구분들 — 안전인증 · 안전확인 · 공급자적합성확인 · 안전기준준수 · 안전성검사. 기준 하나가 여러 구분에 걸릴 수 있어 배열이다';
comment on column public.standard.cert_type_source is
  '인증구분을 정한 근거 — FILENAME(부속서 파일명) · TAXONOMY(품목표) · MANUAL(사람이 고침)';

-- ── 대분류 채우기 ────────────────────────────────────────────────────────
-- 앞의 것이 이기고, 없으면 다음으로. '기타'로라도 채운다 —
-- 빈칸은 화면에서 사라지고, 사라진 것은 아무도 검수하지 않는다.
with tx as (
  select standard_id, mode() within group (order by item_group) as item_group
  from public.taxonomy_standard group by standard_id
)
update public.standard s
set item_group = coalesce(
      tx.item_group,
      case
        when s.cert_scheme = '전기용품' then '전기용품'
        when coalesce(s.item_name, s.display_name) ~ '어린이|유아|아동|학용품|완구'
          then '어린이제품'
        when s.cert_scheme in ('안전확인', '안전인증', '공급자적합성', '안전기준준수')
          then '생활용품'
      end,
      '기타'),
    item_group_source = case
      when tx.item_group is not null then 'TAXONOMY'
      when s.cert_scheme = '전기용품' then 'SCHEME'
      when coalesce(s.item_name, s.display_name) ~ '어린이|유아|아동|학용품|완구' then 'NAME'
      when s.cert_scheme in ('안전확인', '안전인증', '공급자적합성', '안전기준준수') then 'SCHEME'
      else 'UNKNOWN'
    end
from (select id from public.standard) ids
left join tx on tx.standard_id = ids.id
where s.id = ids.id and s.item_group_source is distinct from 'MANUAL';

-- ── 인증구분 채우기 ──────────────────────────────────────────────────────
-- 부속서 계열은 파일명이 문서 자체의 인증구분을 말한다(「안전확인 부속서 6(완구)」).
-- 전기용품 계열은 파일명에 인증구분이 없으므로 품목표에서 가져온다.
-- '공급자적합성'은 법령 용어인 '공급자적합성확인'으로 맞춘다.
with tx as (
  select ts.standard_id,
         array_agg(distinct pt.cert_scheme order by pt.cert_scheme) as types
  from public.taxonomy_standard ts
  join public.product_taxonomy pt
    on pt.item_group = ts.item_group
   and pt.item = ts.item
   and coalesce(pt.sub_item, '') = coalesce(ts.sub_item, '')
  where nullif(btrim(pt.cert_scheme), '') is not null
  group by ts.standard_id
)
update public.standard s
set cert_types = coalesce(
      case
        when s.cert_scheme in ('안전인증', '안전확인', '안전기준준수') then array[s.cert_scheme]
        when s.cert_scheme = '공급자적합성' then array['공급자적합성확인']
      end,
      tx.types),
    cert_type_source = case
      when s.cert_scheme in ('안전인증', '안전확인', '안전기준준수', '공급자적합성') then 'FILENAME'
      when tx.types is not null then 'TAXONOMY'
      else null
    end
from (select id from public.standard) ids
left join tx on tx.standard_id = ids.id
where s.id = ids.id and s.cert_type_source is distinct from 'MANUAL';

create index if not exists standard_item_group_idx on public.standard (item_group);

-- ── 뷰는 이제 계산하지 않고 칸을 읽는다 ──────────────────────────────────
-- 칸이 늘고 순서가 바뀌므로 create or replace 로는 안 된다(있던 칸의 이름을
-- 바꾸는 것으로 읽힌다). 057 이 만든 뷰를 지우고 다시 만든다.
drop view if exists public.standard_view;

create view public.standard_view
with (security_invoker = true) as
with tx as (
  select ts.standard_id,
         array_agg(distinct ts.item)     filter (where nullif(btrim(ts.item), '')     is not null) as items,
         array_agg(distinct ts.sub_item) filter (where nullif(btrim(ts.sub_item), '') is not null) as sub_items,
         count(*)::int                                              as link_count,
         count(*) filter (where ts.review_status = 'approved')::int as approved_count
  from public.taxonomy_standard ts
  group by ts.standard_id
)
select
  s.id,
  s.display_name,
  s.standard_no,
  s.cert_scheme,
  s.item_name,
  s.title_ko,
  s.total_pages,
  s.is_current,
  s.source_filename,
  coalesce(s.item_group, '기타')            as item_group,
  coalesce(s.item_group_source, 'UNKNOWN')  as item_group_source,
  s.cert_types,
  s.cert_type_source,
  tx.items,
  tx.sub_items,
  coalesce(tx.link_count, 0)     as link_count,
  coalesce(tx.approved_count, 0) as approved_count
from public.standard s
left join tx on tx.standard_id = s.id;

comment on view public.standard_view is
  '안전기준 + 대분류 + 인증구분 + 세부품목. 대분류·인증구분은 standard 의 칸을 그대로 읽는다(058)';

revoke all on public.standard_view from anon, authenticated;
