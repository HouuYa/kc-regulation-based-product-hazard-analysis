-- -----------------------------------------------------------------------------
-- 053 어린이제품 공통안전기준을 어린이제품에만 붙인다
--
-- 「어린이제품 공통안전기준」 고시 1. 적용범위 비고는 두 가지를 함께 말한다.
--   "개별 안전기준이 있는 어린이제품은 개별 안전기준과 어린이제품 공통안전기준을
--    모두 적용한다" — 어린이제품이면 반드시 함께 본다
--   적용범위는 만 13세 이하 어린이가 사용하거나 어린이를 위하여 사용되는 물품
--                                                — 어린이제품이 아니면 적용하지 않는다
--
-- 우리 체계는 두 번째를 어기고 있었다. scripts/seed-scopes.ts 가 이름이 붙은 기준
-- 33종을 품목으로 만들면서 category 를 전부 '어린이제품' 으로 박아 넣었고, 그
-- 결과 「가스라이터」·「우산 및 양산」·「디지털도어록」·「휴대용 예초기의 날 및
-- 보호덮개」 같은 생활용품 품목에도 어린이제품 공통안전기준이 COMMON 으로 걸려
-- 있었다. 생활용품 사고에 어린이제품 유해원소·프탈레이트 시험이 근거로 제시된다.
--
-- 여기서 두 가지를 바로잡는다.
--   1) 품목군을 법정 품목 대응표(product_taxonomy.item_group)로 다시 판정한다
--   2) 어린이제품이 아닌 품목에서 COMMON 관계를 뗀다
--
-- 첫 번째를 어긴 쪽(어린이제품인데 공통기준이 안 붙는 경로)은 데이터가 아니라
-- 코드 문제라 src/lib/cases/resolve-scope.ts 의 withChildCommon 에서 고쳤다.
--
-- 지우는 것은 seed 로 다시 만들 수 있는 파생 행뿐이다(npm run scopes:seed).
-- 담당자가 손으로 확정한 값(confirmed_by 가 있는 행)은 건드리지 않는다.
-- -----------------------------------------------------------------------------

-- 1) 품목군 재판정
--
--    이름이 여러 품목군에 걸리면(예: 「방한용·패션용·스포츠용 마스크」는 어린이제품과
--    생활용품 양쪽에 있다) 어린이제품으로 본다. 붙여서 생기는 손해는 담당자가
--    시험항목을 더 보는 것이고, 빼서 생기는 손해는 유해원소 항목을 통째로
--    놓치는 것이다.
--
--    대응표에 아직 없는 품목은 이름으로 보수적으로 판정한다 — 「어린이용
--    인라인스케이트」가 실제로 대응표에 없다.
update public.product_scope ps
set category = c.category
from (
  select ps.id,
         case
           when ps.name ~ '어린이|유아|아동'
             or exists (
               select 1 from public.product_taxonomy t
               where t.item_group = '어린이제품'
                 and public.scope_term_key(ps.name) in (
                       public.scope_term_key(t.item),
                       public.scope_term_key(t.sub_item),
                       public.scope_term_key(t.sub_sub_item)))
           then '어린이제품'
           when exists (
               select 1 from public.product_taxonomy t
               where t.item_group = '전기용품'
                 and public.scope_term_key(ps.name) in (
                       public.scope_term_key(t.item),
                       public.scope_term_key(t.sub_item),
                       public.scope_term_key(t.sub_sub_item)))
           then '전기용품'
           when exists (
               select 1 from public.product_taxonomy t
               where t.item_group = '생활용품'
                 and public.scope_term_key(ps.name) in (
                       public.scope_term_key(t.item),
                       public.scope_term_key(t.sub_item),
                       public.scope_term_key(t.sub_sub_item)))
           then '생활용품'
           else '기타'
         end as category
  from public.product_scope ps
) c
where c.id = ps.id
  and ps.category is distinct from c.category;

-- 2) 어린이제품이 아닌 품목에서 공통안전기준을 뗀다
delete from public.standard_applicability a
using public.product_scope ps
where ps.id = a.product_scope_id
  and a.relation = 'COMMON'
  and ps.category is distinct from '어린이제품'
  and a.confirmed_by is null;

comment on column public.product_scope.category is
  '법정 품목군(어린이제품/전기용품/생활용품/기타). 어린이제품이면 공통안전기준을 함께 적용한다(053)';
