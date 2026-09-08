/*
  안전기준에 「대분류」와 「품목명」을 붙인다 — 화면이 검수 자리가 되게 (057)

  담당자 지적 두 가지에서 나왔다.

  1) "KC 60335-2-17 에 왜 명칭이 없는지"
     이름이 없는 게 아니라 화면이 두 칸(title_ko, item_name)만 읽고 있었다.
     실제 품목명은 taxonomy_standard.sub_item 에 이미 있다 —
     KC 60335-2-17 → 「전기담요 및 매트, 전기침대」. 안전기준 담당자는 품목별로
     나뉘어 있어 자기 품목군 밖은 일반인보다도 모르는 경우가 많다. 번호만
     보여 주면 검수를 할 수가 없다.

  2) "전기/생활/어린이는 대분류로 무조건 구분하여 정렬"
     지금은 그럴 칸이 없다. cert_scheme 한 칸에 「전기용품」(대분류)과
     「안전확인·안전인증·공급자적합성·안전기준준수」(인증방식)가 섞여 있다.
     축이 다른 두 값이 한 칸에 들어 있어서 이 칸으로는 대분류를 만들 수 없다.

  왜 표에 칸을 더하지 않고 뷰로 만드는가
     대분류의 근거인 taxonomy_standard 는 검수하면서 계속 바뀐다. 값을 복사해
     두면 검수 결과와 화면이 어긋난다. 뷰는 항상 지금의 대응을 따라간다.

  대분류를 정하는 순서 (앞의 것이 이기고, 없으면 다음으로)
     1. taxonomy_standard 의 최빈값 — 담당자 엑셀에서 온 품목→기준 대응
     2. cert_scheme = '전기용품'
     3. 이름에 어린이·유아·아동·학용품·완구
     4. 나머지 부속서 계열은 생활용품
     5. 그래도 모르면 '기타' — 빈칸으로 두지 않는다. 빈칸은 화면에서 사라지고,
        사라진 것은 아무도 검수하지 않는다.

  실측(2026-09-09): 1번으로 53건, 2번으로 21건, 3번으로 2건이 정해진다.
  전기용품 43 · 생활용품 17 · 어린이제품 16 · 기타 0.
*/

create or replace view public.standard_view
with (security_invoker = true) as
with tx as (
  select ts.standard_id,
         mode() within group (order by ts.item_group)                     as item_group,
         array_agg(distinct ts.item)     filter (where nullif(btrim(ts.item), '')     is not null) as items,
         array_agg(distinct ts.sub_item) filter (where nullif(btrim(ts.sub_item), '') is not null) as sub_items,
         count(*)::int                                                    as link_count,
         count(*) filter (where ts.review_status = 'approved')::int       as approved_count
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
  coalesce(
    tx.item_group,
    case
      when s.cert_scheme = '전기용품' then '전기용품'
      when coalesce(s.item_name, s.display_name) ~ '어린이|유아|아동|학용품|완구' then '어린이제품'
      when s.cert_scheme in ('안전확인', '안전인증', '공급자적합성', '안전기준준수')
        then '생활용품'
    end,
    '기타'
  ) as item_group,
  -- 대분류를 무엇으로 정했는지. 화면이 「담당자 대응에서」인지 「이름으로 추정」인지
  -- 밝힐 수 있어야 검수가 된다.
  case
    when tx.item_group is not null then 'TAXONOMY'
    when s.cert_scheme = '전기용품' then 'SCHEME'
    when coalesce(s.item_name, s.display_name) ~ '어린이|유아|아동|학용품|완구' then 'NAME'
    when s.cert_scheme in ('안전확인', '안전인증', '공급자적합성', '안전기준준수')
      then 'SCHEME'
    else 'UNKNOWN'
  end as item_group_source,
  tx.items,
  tx.sub_items,
  coalesce(tx.link_count, 0)     as link_count,
  coalesce(tx.approved_count, 0) as approved_count
from public.standard s
left join tx on tx.standard_id = s.id;

comment on view public.standard_view is
  '안전기준 + 대분류(전기용품·생활용품·어린이제품·기타) + 품목명. item_group_source 는 대분류의 근거(TAXONOMY=담당자 대응, SCHEME=인증구분, NAME=이름 추정)';

revoke all on public.standard_view from anon, authenticated;
