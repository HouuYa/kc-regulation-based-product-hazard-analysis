-- =============================================================================
-- 사고조사보고서 첨부 사진 — 추출·보관·비전 분석
--
-- 실물 확인 2026-09-02: 사고 5건 중 다수가 "시험 결과 안전기준 적합"이라는
-- 텍스트만 남아 원인 미확인으로 끝났다(구현이력 라운드 4/5). 보고서에 실제로
-- 큰 삽입 사진이 있는 건(가습기 사건, 4장)도 확인했다 — 텍스트에 없는 손상 단서가
-- 사진에는 있을 수 있다는 뜻이라 비전 LLM 분석을 붙인다.
--
-- source_file 에 딸린 사진이라 source_file_id 로만 연결한다(§7.1 원본층과 같은
-- 원칙 — case_event 는 source_file 을 통해 간접 조회).
-- =============================================================================

create table if not exists public.source_file_image (
  id                 bigint generated always as identity primary key,
  source_file_id     bigint not null references public.source_file(id) on delete cascade,
  page_number        int not null,
  storage_path       text not null,
  width              int not null,
  height             int not null,
  byte_size          int not null,

  -- 비전 LLM 분석 결과 (src/lib/llm/vision.ts)
  is_relevant_photo  boolean,
  description        text,
  hazard_note        text,
  vision_model       text,
  analyzed_at        timestamptz,

  created_at         timestamptz not null default now(),
  unique (source_file_id, page_number, storage_path)
);

comment on table public.source_file_image is
  '사고조사보고서 PDF에서 추출한 삽입 사진 + 비전 LLM 분석 결과';
comment on column public.source_file_image.is_relevant_photo is
  '실제 사고/제품 증거 사진인지(true) 로고·직인 같은 장식 이미지인지(false). LLM 판단, null=미분석';

create index if not exists source_file_image_file_idx on public.source_file_image (source_file_id);

alter table public.source_file_image enable row level security;

-- 기존 originals 버킷은 PDF/텍스트만 허용했다(010). 사진을 같은 버킷의
-- accident-photo/ 하위에 보관하므로 image/jpeg 를 추가한다.
update storage.buckets
set allowed_mime_types = array['application/pdf', 'text/markdown', 'application/json', 'text/plain', 'image/jpeg']
where id = 'originals';
