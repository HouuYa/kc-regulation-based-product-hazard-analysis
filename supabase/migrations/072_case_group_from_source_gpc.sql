-- =============================================================================
-- 대분류(전기·생활·어린이)를 원본 DB 의 품목분류에서도 가져온다
--
-- 담당자 요청 (2026-10-07)
--   "해외 리콜에서 제품분류된 것은 DB에서 받은 그대로 사용 부탁합니다. 다 검토하도록
--    되어 있네요."
--
-- 무엇이 문제였나
--   059 의 case_event_group 은 서류의 제품명을 품목 용어 사전(scope_term)으로 옮겨서만
--   대분류를 얻었다. 사전에 없는 이름은 「기타」다. 해외 리콜 2,399건 중 913건만
--   대분류가 붙고 1,486건이 「기타」로 빠져 있었다.
--
--   그런데 원본(Recall Hub·OECD 포털)이 1,939건에 GPC 브릭 코드를 보내 주고 있고,
--   법정 품목표(product_taxonomy)에도 브릭 코드가 있다. 받은 분류로 대분류를 바로 알 수
--   있는데 쓰지 않고 있었다.
--
-- 규칙
--   1) 품목 용어 사전에서 정해진 대분류가 있으면 그대로 쓴다(059 와 같다).
--      담당자가 검수하는 사전이라 우선한다.
--   2) 없으면 원본 GPC 브릭 → 법정 품목표로 대분류를 얻는다. 브릭 하나가 대분류 여럿에
--      걸치면(476건) 고르지 않는다 — 「기타」로 남겨 사람이 보게 한다.
--      출처가 담당자 확정(EXPERT)이나 등록국 신고(OECD)일 때만 쓴다(lib/gpc/provenance.ts
--      의 needsReview 와 같은 경계). 이 체계 AI 가 붙인 코드는 쓰지 않는다.
--   standard_count 는 사전 경로에서만 센다. GPC 경로는 기준이 아니라 대분류만 알려 주므로 0.
--
-- 실측(적용 전 조회, 2026-10-07): 원본 GPC 가 있는 해외 리콜 1,939건 중 1,820건이 법정
-- 품목표와 맞고, 대분류가 하나로 정해지는 것이 1,344건이다.
-- =============================================================================

create or replace view public.case_event_group
with (security_invoker = true) as
with by_term as (
  select ev.id as case_id,
         mode() within group (order by s.item_group) as item_group,
         count(distinct s.id)::int as standard_count
  from public.case_event ev
  join public.scope_term t
    on t.term_key = public.scope_term_key(ev.item_name) and t.review_status <> 'rejected'
  join public.standard s
    on s.id = t.standard_id and s.is_current and s.item_group is not null
  group by ev.id
),
by_gpc as (
  select ev.id as case_id, min(t.item_group) as item_group
  from public.case_event ev
  join public.product_taxonomy t on t.brick_code = ev.gpc_brick_code
  where ev.gpc_source in ('EXPERT', 'OECD')
    -- 빈 대분류 행은 원본 엑셀에서 넘어온 것 — gpc/domestic.ts 의 lookupDomestic 과 같은 경계
    and nullif(btrim(t.item_group), '') is not null
  group by ev.id
  having count(distinct t.item_group) = 1
)
select case_id, item_group, standard_count from by_term
union all
select g.case_id, g.item_group, 0 from by_gpc g
where not exists (select 1 from by_term b where b.case_id = g.case_id);

comment on view public.case_event_group is
  '사건의 대분류. 품목 용어 사전이 우선이고, 없으면 원본 GPC 브릭 → 법정 품목표(대분류가 하나일 때만). 072';

revoke all on public.case_event_group from anon, authenticated;
