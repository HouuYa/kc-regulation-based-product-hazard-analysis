-- =============================================================================
-- "이을 기준이 없다"도 남긴다
--
-- 무엇이 잘못돼 있었나 (담당자 지적, 2026-09-06)
--   전기용품 187종을 이어 보니 103건이 이어지고 84건은 모델이 "해당 기준 없음"으로
--   거절했다. 그런데 그 **거절 이유가 어디에도 남지 않았다** — 콘솔에 묶음당 두 건만
--   찍고 버렸다. 담당자는 "왜 이 품목엔 기준이 없지?"를 확인할 방법이 없었다.
--
--   이 저장소가 이미 세운 원칙과 어긋난다. match.ts 에 이렇게 적혀 있다.
--     "결과 0건을 버리지 않는다 — '대응 조항이 없음'이 그 자체로 산출물이다"
--   품목 쪽에서도 같아야 한다.
--
-- 거절이 값어치 있는 두 가지 이유
--   1) 담당자가 그 자리에서 바로잡을 수 있다 — "아니다, 이 기준이다"
--   2) 정말로 기준이 없는 품목은 **「적재해야 할 기준」 목록**이 된다.
--      실제로 모델이 "자동판매기는 KC 60335-2-75 가 필요한데 목록에 없다"고 짚었다.
--      §4.2 의 "필요한 기준 8종이 없다"와 같은 갈래의 발견이다.
--
-- 왜 같은 표에 담나
--   담당자는 한 품목을 볼 때 "이어졌나 / 안 이어졌나"를 함께 본다. 표를 나누면
--   두 곳을 오가야 한다. standard_id 가 비어 있으면 "이을 기준을 못 찾았다"는 뜻이다.
-- =============================================================================

alter table public.taxonomy_standard
  alter column standard_id drop not null;

comment on column public.taxonomy_standard.standard_id is
  '이어지는 기준. 비어 있으면 이을 기준을 찾지 못한 것이고, 그 사유가 evidence 에 있다';

-- 기존 유니크 인덱스는 standard_id 가 NULL 이면 중복을 막지 못한다
-- (SQL 에서 NULL 은 서로 같지 않다). coalesce 로 0 을 맞춰 한 품목에 "없음"이 한 번만 담기게 한다
drop index if exists public.taxonomy_standard_uniq_idx;

create unique index if not exists taxonomy_standard_uniq_idx
  on public.taxonomy_standard
     (item_group, coalesce(sub_item, ''), coalesce(item, ''), coalesce(standard_id, 0));

-- 화면이 "이을 기준을 못 찾은 품목"만 따로 볼 수 있게 한다
create index if not exists taxonomy_standard_nomatch_idx
  on public.taxonomy_standard (item_group, review_status)
  where standard_id is null;
