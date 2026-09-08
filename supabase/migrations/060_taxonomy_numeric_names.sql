/*
  품목명 자리에 숫자만 든 행을 화면에서 뺀다 (060)

  배포된 화면을 실제로 열어 보고 찾았다. 안전기준 목록의 「안전인증 부속서
  5(가스라이터)」 줄에 「이 기준이 걸리는 품목 123」이라고 적혀 있었다.
  담당자가 이것을 보면 무엇을 검수해야 할지 알 수 없다.

  원인은 우리 코드가 아니라 원본 엑셀이다. `product_taxonomy` 를 옮길 때
  품목명 칸에 숫자(행 번호나 수량으로 보이는 값)가 들어온 행이 있고,
  `taxonomy_standard` 가 그것을 그대로 물려받았다. 실측 54행이다.

  왜 지우지 않고 가리기만 하는가
    `product_taxonomy` 는 협회가 준 원본이라 우리가 고치지 않는다(스키마 문서).
    원본을 손대면 다음에 다시 적재할 때 되살아나고, 무엇을 고쳤는지도 남지 않는다.
    화면에 이름으로 내보내지 않는 것으로 충분하다 — 숫자는 품목명이 아니다.
    원본을 고치는 일은 담당자에게 알리고 엑셀 쪽에서 처리할 일이다.
*/

drop view if exists public.standard_view;

create view public.standard_view
with (security_invoker = true) as
with tx as (
  select ts.standard_id,
         array_agg(distinct ts.item)
           filter (where nullif(btrim(ts.item), '') is not null
                     and ts.item !~ '^[0-9[:space:],.]+$')     as items,
         array_agg(distinct ts.sub_item)
           filter (where nullif(btrim(ts.sub_item), '') is not null
                     and ts.sub_item !~ '^[0-9[:space:],.]+$') as sub_items,
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
  '안전기준 + 대분류 + 인증구분 + 세부품목. 품목명 자리에 숫자만 든 행은 이름으로 내보내지 않는다(060)';

revoke all on public.standard_view from anon, authenticated;
