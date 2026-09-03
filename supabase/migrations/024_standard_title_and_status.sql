-- =============================================================================
-- 기준 한글 명칭 · 자료 종류별 진행 현황
--
-- 두 가지를 담는다. 둘 다 "화면이 담당자의 말로 말하게" 하기 위한 것이다.
--
-- 1) standard.title_ko — 기준의 한글 명칭
--
--    담당자 지적: "KC 60335-1라고만 쓰지 말고, 기준 명칭도 같이 작성"
--
--    왜 번호만 나왔나 (원인 확인)
--      display_name 은 파일명에서 만들어진다(parse-result-json.ts parseFilename).
--      "10. 안전확인 부속서 16(유아용 캐리어)_result.json" 처럼 파일명에 품목이 들어
--      있는 것은 괄호 안을 item_name 으로 뽑아 쓸 수 있었지만,
--      "1. KC 60335-2-13_result.json" 은 파일명에 번호밖에 없어 이름이 만들어지지
--      않았다. 76건 중 전기용품(KC 60335 계열) 전부가 이 상태다.
--
--    그런데 원본 JSON 안에는 한글 명칭이 있다 (실측으로 확인)
--      KC 60335-2-67 → "가정용 및 이와 유사한 전기기기의 안전성"
--                       "제2-67부: 상업용 및 산업용 바닥처리 청소기의 개별 요구사항"
--      문서 첫 장의 data-label="title" 요소에 들어 있다. 파일명만 보느라 못 쓰고
--      있었을 뿐이다. scripts/backfill-standard-title.ts 가 이 값을 채운다.
--
--    왜 display_name 을 고치지 않고 새 컬럼인가
--      display_name 은 파일명과 1:1 로 대응해야 한다 — 같은 기준을 다시 적재할 때
--      "이미 있는 것인가"를 이 이름으로 판단하기 때문이다(sync.ts). 표시용 이름을
--      거기 섞으면 그 판단이 흔들린다. 표시와 식별을 분리해 둔다.
--
-- 2) embed_status 뷰를 사고보고서 / 리콜로 나눈다
--
--    담당자 지적: "사건 (사고·리콜)를 사고보고서와 리콜로 분리"
--
--    둘은 들어오는 경로가 다르다. 사고보고서는 사람이 PDF 를 올려 확인까지 해야
--    하고, 리콜은 외부 표에서 자동으로 들어오며 코드도 이미 붙어 온다. 한 줄로
--    합쳐 놓으면 어느 쪽이 밀린 것인지 알 수 없다.
--
--    발송 장부(embed_queue)는 그대로 둔다 — 거기서는 둘을 구분할 이유가 없고,
--    구분하려면 CHECK 제약과 020 의 함수들을 함께 고쳐야 해서 위험만 는다.
--    보여 주는 쪽에서만 나눈다.
-- =============================================================================

alter table public.standard
  add column if not exists title_ko text;

comment on column public.standard.title_ko is
  '기준의 한글 명칭. 원본 JSON 첫 장의 제목에서 뽑는다(backfill-standard-title.ts). display_name 은 파일명 기반 식별자라 따로 둔다';

-- -----------------------------------------------------------------------------
-- 진행 현황 — clause / 사고보고서 / 리콜 세 줄
-- -----------------------------------------------------------------------------
create or replace view public.embed_status
with (security_invoker = true) as
with t as (
  select 'clause'::text as target_table,
         count(*)::int as total,
         count(*) filter (where embedding is not null)::int as embedded,
         count(*) filter (where embedding is null
                            and search_text is not null
                            and length(btrim(search_text)) > 0)::int as pending,
         count(distinct embedding_model)::int as models,
         null::text as source_filter
  from public.clause

  union all
  select 'accident',
         count(*)::int,
         count(*) filter (where embedding is not null)::int,
         count(*) filter (where embedding is null
                            and search_text is not null
                            and length(btrim(search_text)) > 0)::int,
         count(distinct embedding_model)::int,
         'ACCIDENT'
  from public.case_event where source_type = 'ACCIDENT'

  union all
  select 'recall',
         count(*)::int,
         count(*) filter (where embedding is not null)::int,
         count(*) filter (where embedding is null
                            and search_text is not null
                            and length(btrim(search_text)) > 0)::int,
         count(distinct embedding_model)::int,
         'RECALL'
  from public.case_event where source_type in ('RECALL_DOMESTIC', 'RECALL_OVERSEAS')
),
q as (
  -- 장부의 case_event 행을 사건 종류로 되짚어 나눈다
  select case
           when eq.target_table = 'clause' then 'clause'
           when ev.source_type = 'ACCIDENT' then 'accident'
           else 'recall'
         end as target_table,
         count(*) filter (where eq.status = 'sent')::int   as in_flight,
         count(*) filter (where eq.status = 'failed')::int as failed,
         count(*) filter (where eq.status = 'failed' and eq.attempts >= 5)::int as parked
  from public.embed_queue eq
  left join public.case_event ev
    on eq.target_table = 'case_event' and ev.id = eq.row_id
  group by 1
)
select t.target_table,
       t.total,
       t.embedded,
       t.pending,
       t.models,
       coalesce(q.in_flight, 0)::int as in_flight,
       coalesce(q.failed,    0)::int as failed,
       coalesce(q.parked,    0)::int as parked
from t left join q on q.target_table = t.target_table;

comment on view public.embed_status is
  'pending=아직 의미 검색 준비 안 됨, in_flight=처리 중, parked=5회 실패해 세워 둔 건(사람이 봐야 함). 행은 clause/accident/recall 셋';

revoke all on public.embed_status from anon, authenticated;
