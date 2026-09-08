/*
  사고보고서·리콜에도 대분류를 붙인다 (059) — 담당자 요청

  "검토 시 전기/생활/어린이는 대분류로 무조건 구분하여 정렬될 수 있도록.
   가능하다면 해외 리콜도 그렇게 해 주고, 애매하면 기타로 빼면 된다."

  사건 자체에는 대분류가 없다. 있는 것은 서류에 적힌 제품 이름뿐이다.
  그 이름을 품목 용어 사전(scope_term)으로 옮기면 안전기준이 나오고, 기준에는
  058 로 대분류가 붙어 있다. 그 두 걸음을 이어 놓은 뷰다.

  왜 case_event 에 칸을 더하지 않는가
    용어 사전은 담당자가 검수하며 계속 바뀐다. 값을 복사해 두면 사전을 고쳐도
    목록의 대분류는 옛날 값 그대로 남는다. 뷰는 늘 지금의 사전을 따라간다.

  얼마나 채워지는가 (실측 2026-09-09)
    사고보고서 71건 중 55건(77%) — 전기용품 43 · 생활용품 7 · 어린이제품 5
    해외 리콜 2,338건 중 765건(33%) — 어린이제품 344 · 전기용품 311 · 생활용품 110
    나머지는 아직 사전에 없는 이름이다. 화면에서는 「기타」로 뺀다 — 담당자 말대로
    애매한 것을 억지로 어느 한쪽에 넣지 않는다. 사전이 자라면 이 숫자도 자란다.

  product_scope.category 를 쓰지 않는 이유
    그 칸은 품목을 확정한 사건에만 있는데, 실측 결과 2,342건 중 48건에만 있다.
    그것으로 나누면 목록의 98%가 「기타」가 된다.
*/

create or replace view public.case_event_group
with (security_invoker = true) as
select ev.id as case_id,
       mode() within group (order by s.item_group) as item_group,
       count(distinct s.id)::int                   as standard_count
from public.case_event ev
join public.scope_term t
  on t.term_key = public.scope_term_key(ev.item_name)
 and t.review_status <> 'rejected'
join public.standard s
  on s.id = t.standard_id
 and s.is_current
 and s.item_group is not null
group by ev.id;

comment on view public.case_event_group is
  '사건(사고보고서·리콜)의 대분류. 서류의 제품명 → 품목 용어 사전 → 안전기준의 대분류 순으로 잇는다(059). 사전에 없는 이름은 행이 없고, 화면은 그것을 「기타」로 다룬다';

revoke all on public.case_event_group from anon, authenticated;

-- 용어 사전을 term_key 로 찾는 일이 이제 목록 조회마다 일어난다
create index if not exists scope_term_term_key_idx on public.scope_term (term_key);
