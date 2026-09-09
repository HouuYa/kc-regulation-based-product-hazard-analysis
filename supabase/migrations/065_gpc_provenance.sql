/*
  품목분류가 어디서 온 것인지 함께 남긴다 (065)

  담당자 지적: "OECD 포털이 보내는 segment/family/class/brick 코드는 각 나라들이
  OECD 포털에 등록할 때 사용하는 코드로 신빙성이 매우 높습니다."

  맞는 말이고, 우리가 그것을 버리고 있었다. 원본 표에 코드가 와 있는데도 읽지
  않고, 필요할 때마다 우리 AI 로 다시 붙이고 있었다 — 신고된 값을 놔두고 추정한
  셈이다.

  OECD 등록 규약을 원자료로 확인했다
    docs/OECD리콜등록/supabase/recalls_oecd_staging_rows.sql 안의 신고 XML 100건에서
    product_code 블록의 실제 모양을 셌다.

      <product_code>
        <publication>2024-05-01</publication>   판(버전)
        <brick>10001840</brick>                 브릭까지 좁혔으면
      </product_code>

    태그 분포는 publication 100 · brick 84 · segment 16 · family 14 · class 6 이다.
    **등록국이 좁힌 만큼만 채운다** — 브릭까지 못 좁히면 세그먼트나 패밀리에서 멈춘다.
    우리가 만들어 둔 계위 모델(BRICK/CLASS/FAMILY/SEGMENT/NONE)과 정확히 같은 규약이다.

  우리 원본 표에도 이미 와 있다
    실측(2026-09-09) 승인·관리대상 2,356건 중 1,904건(81%)에 classification_code 가
    있다. 348종 중 341종은 브릭, 나머지는 클래스·패밀리 모양이다 — 역시 같은 규약이다.
    다만 그 값의 classification_method 는 전부 'ai_auto' 라, 등록국이 신고한 코드가
    아니라 리콜 허브가 스스로 붙인 것이다. 그래서 「신고 코드」와 구별해 적어야 한다.

  출처를 적지 않으면 좋은 값과 추정을 섞게 된다
    EXPERT      담당자가 확정                       가장 높다
    OECD        등록국이 OECD 포털에 신고한 코드    매우 높다
    SOURCE_AI   리콜 허브가 붙인 코드(ai_auto)      참고
    OUR_AI      우리 체계가 붙인 코드               참고

    낮은 출처가 높은 출처를 덮지 않게 하는 것이 이 칸의 목적이다. 우리 AI 배치를
    다시 돌렸다고 등록국이 신고한 코드가 지워지면 안 된다.

  판(publication)도 함께 남긴다
    GPC 는 판마다 코드가 생기고 없어진다. 실측에서 원본 코드 348종 중 7종이 우리
    카탈로그에 없었는데(10002209 등), 판이 다르면 그럴 수 있다. 판을 모르면 「없는
    코드」인지 「다른 판의 코드」인지 가릴 수 없다.
*/

-- ── 사건 ─────────────────────────────────────────────────────────────────
alter table public.case_event
  add column if not exists gpc_source      text
    check (gpc_source in ('EXPERT', 'OECD', 'SOURCE_AI', 'OUR_AI')),
  add column if not exists gpc_publication text;

comment on column public.case_event.gpc_source is
  '품목분류가 어디서 왔나 — EXPERT(담당자) · OECD(등록국 신고) · SOURCE_AI(리콜 허브) · OUR_AI(우리 판정). 낮은 출처가 높은 출처를 덮지 않는다(065)';
comment on column public.case_event.gpc_publication is
  'GPC 판(예: 2024-05-01). 판이 다르면 같은 번호가 다른 뜻일 수 있다';

-- ── 원본층 ───────────────────────────────────────────────────────────────
-- 원본이 준 코드는 원본층에 그대로 둔다. 파생 쪽을 다시 계산해도 원본은 남는다(§7.1)
alter table public.recall_cache
  add column if not exists gpc_code        text,
  add column if not exists gpc_source      text,
  add column if not exists gpc_publication text;

comment on column public.recall_cache.gpc_code is
  '원본이 준 품목분류 코드. 브릭이 아닐 수 있다 — OECD 규약은 등록국이 좁힌 계위까지만 채운다(065)';

-- ── 이력 ─────────────────────────────────────────────────────────────────
alter table public.gpc_assignment
  add column if not exists source      text not null default 'OUR_AI',
  add column if not exists publication text;

comment on column public.gpc_assignment.source is
  '이 판정의 출처. OECD·SOURCE_AI 는 AI 를 부르지 않고 신고된 코드를 그대로 읽은 것이라 query_text 가 비어 있다(065)';

-- ── 품목 사전 ────────────────────────────────────────────────────────────
alter table public.scope_term_gpc
  drop constraint if exists scope_term_gpc_source_check;
alter table public.scope_term_gpc
  add constraint scope_term_gpc_source_check
    check (source in ('EXPERT', 'SEMANTIC', 'LLM', 'OECD', 'SOURCE_AI'));

-- ── 이미 받아 둔 리콜에서 코드를 꺼내 채운다 ─────────────────────────────
-- raw 에 원본 행이 통째로 들어 있어 다시 받아 올 필요가 없다.
update public.recall_cache
set gpc_code   = nullif(btrim(raw ->> 'classification_code'), ''),
    gpc_source = case
      when nullif(btrim(raw ->> 'classification_code'), '') is null then null
      -- 지금 원본의 method 는 전부 ai_auto 다. 나중에 등록국 신고 코드가 오면
      -- 그 값이 여기서 OECD 로 갈린다
      when raw ->> 'classification_method' in ('oecd', 'source', 'registered') then 'OECD'
      else 'SOURCE_AI'
    end
where gpc_code is null;

-- 사건 쪽에도 옮긴다. 사람이 확정해 둔 값은 건드리지 않는다
update public.case_event e
set gpc_brick_code = c.gpc_code,
    gpc_source     = c.gpc_source
from public.recall_cache c
where c.case_id = e.id
  and c.gpc_code is not null
  and e.gpc_source is distinct from 'EXPERT'
  and e.gpc_brick_code is null;

create index if not exists case_event_gpc_source_idx
  on public.case_event (gpc_source) where gpc_source is not null;
