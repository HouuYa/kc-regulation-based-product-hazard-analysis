-- =============================================================================
-- 055 이 제품이 어린이제품인가 — 담당자 확인값을 받는 칸
--
-- 왜 필요한가
--   「어린이제품 가이드라인」 고시(2020-12-30)는 어린이제품 여부를 색상·포장·광고·
--   소비자 인식·가격대 같은 결정요소로 판정하게 한다. 제품 실물과 판매 맥락을 봐야
--   하는 판단이라 이 체계는 **자동으로 하지 않는다** — 밝은 원색이라고 어린이제품이라
--   결론 내면 그럴듯한 오답이 근거로 제시된다.
--
--   그런데 판정 결과를 받아 적을 자리가 없었다. 담당자가 「토끼 나무 기차」를 보고
--   어린이제품이라고 정해도, 그 판단이 어디에도 남지 않아 다음 사람이 다시 판정해야
--   하고 적용 기준에도 반영되지 않았다. 해외 리콜 2,334건이 이 상태다.
--
-- 무엇이 달라지는가
--   CHILD 로 확정하면 적용 기준에 어린이제품 공통안전기준이 들어간다(053 에서 만든
--   묶음을 사람이 직접 켜는 것이다). NOT_CHILD 면 자동 판정이 붙였더라도 뺀다 —
--   법정 품목군으로 미루어 짐작한 기계 판정보다 실물을 본 사람이 우선이다.
--
--   기본값을 UNCHECKED 로 두는 이유는 recall_cache.domestic_check 와 같다. 확인하지
--   않은 것과 "어린이제품이 아니라고 확인한 것"은 전혀 다른 상태이고, 둘을 같은 칸에
--   담으면 무엇을 더 봐야 하는지 셀 수 없게 된다.
-- =============================================================================

alter table public.case_event
  add column if not exists child_product_check text
    not null default 'UNCHECKED'
    check (child_product_check in ('UNCHECKED', 'CHILD', 'NOT_CHILD', 'UNKNOWN')),
  -- 무엇을 보고 그렇게 판정했는가. 가이드라인의 결정요소(포장·광고·사용연령 표시 …)
  add column if not exists child_product_note text,
  add column if not exists child_product_checked_at timestamptz;

comment on column public.case_event.child_product_check is
  '어린이제품 여부 담당자 확인 (「어린이제품 가이드라인」 고시의 결정요소로 사람이 판정). '
  'CHILD 면 공통안전기준을 적용 기준에 넣고, NOT_CHILD 면 뺀다(055)';
comment on column public.case_event.child_product_note is
  '무엇을 보고 판정했는가 — 사용연령 표시·포장 문구·판매 구역 등. 근거 없이 바꾸지 않는다';

create index if not exists case_event_child_check_idx
  on public.case_event (child_product_check)
  where child_product_check <> 'UNCHECKED';
