-- =============================================================================
-- 법정 품목 ↔ KC안전기준 대응표
--
-- 무엇이 끊겨 있었나 (2026-09-06 실측)
--   검색어 사전을 품목 확정에 결선했는데 효과가 거의 없었다. 단계별로 세어 보니
--   법정 품목에서 기준으로 넘어가는 다리가 없었다.
--
--     "LED등기구" → 법정 품목 "조명기기 > 일반조명기구 > LED등기구"   여기까지 간다
--                              ↓  끊김
--                           KC 60598-2-1
--
--   처음에는 기준 43종에 item_name 이 비어서라고 봤는데, 담당자가 "적용범위와 제목이
--   있으니 그것으로 이어야 한다"고 짚어 주었다. 실제로 적용범위는 73종, 제목은 40종에
--   있다(item_name 은 33종).
--
-- 그런데 글자 맞추기로는 안 된다 — 이것도 재 봤다
--     법정 품목명으로 적용범위 전문검색   187종 중 7종(4%)
--     부분 문자열까지 허용해도          187종 중 11종
--
--     법정 품목  "모발건조기"                        고시의 말
--     적용범위   "피부 또는 모발을 손질하기 위한 전기기기"    기준의 말
--
--   뜻으로 이어야 한다. 그 장치는 이미 있다(scope-semantic.ts) — 적용범위를 임베딩해
--   후보를 좁히고 LLM 이 고른다. 지금은 사건마다 런타임으로 도는데, 법정 품목 목록에
--   **미리 한 번** 돌려 결과를 여기에 담는다.
--
-- 왜 미리 만들어 두나
--   한 번 확정한 "모발건조기 → KC 60335-2-23" 은 그 품목으로 이어지는 모든 사고·리콜에
--   재사용된다. 법정 품목 623종이 리콜 1,553종과 사고 38종을 덮는다.
--
-- 왜 standard.item_name 을 채우지 않고 별도 표인가
--   기준 하나에 품목이 여럿 걸린다(KC 60335-2-23 은 모발건조기·전기머리인두·피부미용기).
--   한 칸에 넣을 수 없다. 대응은 관계이므로 표가 맞는 그릇이다.
--
-- 확정 전에는 쓰지 않는다
--   scope_term·item_keyword 와 같은 규칙이다. 품목이 틀리면 엉뚱한 기준의 시험이
--   담당자에게 근거로 제시된다 — 조용히 틀리는 종류의 고장이다.
-- =============================================================================

create table if not exists public.taxonomy_standard (
  id            bigint generated always as identity primary key,

  -- 법정 품목 (product_taxonomy 와 논리 참조. 원본이 개정되면 그쪽이 통째로 바뀌므로
  -- FK 를 걸지 않고 이름으로 잇는다)
  item_group    text not null,
  item          text,
  sub_item      text,

  standard_id   bigint not null references public.standard(id) on delete cascade,

  source        text not null check (source in ('SEMANTIC_LLM', 'EXPERT')),
  review_status text not null default 'auto_unreviewed'
                  check (review_status in ('auto_unreviewed', 'approved', 'rejected')),

  -- 0~1 자기보고 확신도. 낮은 것부터 담당자가 본다
  confidence    numeric,
  -- 적용범위의 어느 대목을 근거로 골랐는지. 검수 화면이 그대로 보여 준다
  evidence      text,

  reviewed_by   text,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.taxonomy_standard is
  '법정 품목과 KC안전기준의 대응. 적용범위를 뜻으로 견주어 잇고 담당자가 확정한다(049)';
comment on column public.taxonomy_standard.source is
  'SEMANTIC_LLM 적용범위 의미검색 + LLM 선택 / EXPERT 담당자가 직접 고름';
comment on column public.taxonomy_standard.evidence is
  '적용범위의 어느 대목을 근거로 보았는가. 담당자가 확정·반려를 판단하는 재료다';

-- 같은 품목에 같은 기준이 두 번 들어가지 않게 한다.
-- sub_item·item 이 NULL 일 수 있어 coalesce 로 맞춘다(047 과 같은 까닭)
create unique index if not exists taxonomy_standard_uniq_idx
  on public.taxonomy_standard
     (item_group, coalesce(sub_item, ''), coalesce(item, ''), standard_id);

-- 품목으로 기준을 찾는 길 — 검색 경로가 쓰는 방향이다
create index if not exists taxonomy_standard_item_idx
  on public.taxonomy_standard (item_group, sub_item, item)
  where review_status = 'approved';

-- 검수 화면이 쓰는 길
create index if not exists taxonomy_standard_review_idx
  on public.taxonomy_standard (review_status, confidence);

alter table public.taxonomy_standard enable row level security;
revoke all on table public.taxonomy_standard from anon, authenticated;
