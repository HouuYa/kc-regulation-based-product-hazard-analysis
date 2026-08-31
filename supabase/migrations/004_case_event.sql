-- =============================================================================
-- 사건 — 사고보고서 · 리콜을 하나의 형태로 통일
--
-- 근거: 설계문서 §2.2 case_event/case_tag
--   "트랙 A·B 가 같은 엔진을 쓰려면 입력 테이블이 하나여야 함. 출처만 컬럼으로 구분"
--
-- 표 구조에 관한 유보 (§8.1 선결 과제, 결정항목 18)
--   사고보고서 실물을 아직 보지 못했다. 서식이 통일되어 있는지, 한 파일에 사건이
--   여러 건 담기는지, 제품 식별 정보가 어디까지 있는지에 따라 컬럼이 달라진다.
--   그래서 지금은 공통 컬럼 + raw_fields(jsonb) 로 시작하고, 5~10건을 함께 읽은 뒤
--   자주 쓰는 항목만 컬럼으로 승격한다. 표를 먼저 그리고 실물을 나중에 보면
--   안 쓰는 컬럼과 모자란 컬럼이 동시에 생긴다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 업로드 파일과 적재 작업 (화면 A)
--
-- 파일과 사건을 분리해 둔다. 한 파일에 사고가 여러 건 담길 수 있고(§8.1),
-- 그때 파일:사건이 1:N 이 되기 때문이다. 실물 확인 전이지만 분리해 두는 쪽이
-- 나중에 합치는 것보다 싸다.
-- -----------------------------------------------------------------------------
create table if not exists public.source_file (
  id             bigint generated always as identity primary key,
  kind           text not null check (kind in ('ACCIDENT_PDF', 'CODEBOOK_MD', 'STANDARD_JSON')),
  filename       text not null,
  -- 같은 파일 재업로드 판별 (§8.1 중복 방지)
  sha256         text not null,
  storage_path   text,
  byte_size      bigint,
  page_count     int,
  -- 0 에 가까우면 스캔본 신호 (§8.1) — 결정항목 12 의 답을 실측으로 얻는 지점
  extracted_chars int,
  extracted_text text,
  status         text not null default 'pending'
                   check (status in ('pending', 'extracting', 'extracted', 'coded', 'confirmed', 'error')),
  error_reason   text,
  uploaded_at    timestamptz not null default now(),
  unique (kind, sha256)
);

comment on table  public.source_file                 is '업로드 원본 파일과 그 처리 상태. 화면 A 의 건별 진행 표시가 이 표를 읽는다';
comment on column public.source_file.extracted_chars is '추출 글자 수. 0 에 가까우면 텍스트 레이어 없는 스캔본이다(8.1)';
comment on column public.source_file.status          is 'pending→extracting→extracted→coded→confirmed. 확정 전에는 분석 대상에 들어가지 않는다';

create index if not exists source_file_status_idx on public.source_file (kind, status);

-- -----------------------------------------------------------------------------
-- 사건 (사고 · 리콜 공통)
-- -----------------------------------------------------------------------------
create table if not exists public.case_event (
  id             bigint generated always as identity primary key,
  source_file_id bigint references public.source_file(id) on delete set null,

  -- 트랙 A/B 를 가르는 단 하나의 컬럼
  source_type    text not null
                   check (source_type in ('ACCIDENT', 'RECALL_DOMESTIC', 'RECALL_OVERSEAS')),
  -- 외부 시스템의 식별자 (Recall Hub 의 source/guid 등)
  external_ref   text,

  title          text,
  narrative      text not null default '',
  item_name      text,
  gpc_brick_code text,
  model_name     text,
  occurred_on    date,

  -- 서식이 제각각일 가능성에 대비한 자리. 자주 쓰는 항목만 위 컬럼으로 승격한다(8.1)
  raw_fields     jsonb not null default '{}'::jsonb,

  -- 조항과 같은 검색 재료를 갖는다. 세 갈래가 모두 같은 대상을 향해야 하기 때문
  keywords       text[] not null default '{}',
  chunk_summary  text,
  search_text    text,
  embedding      extensions.vector(1536),
  embedding_model text,

  -- 확정 전에는 분석 대상에 들어가지 않는다 (§8.1)
  is_confirmed   boolean not null default false,
  confirmed_at   timestamptz,
  created_at     timestamptz not null default now()
);

comment on table  public.case_event                is '사고·리콜을 하나의 형태로 통일. 트랙 A·B 가 같은 매칭 엔진을 쓰기 위함(2.2)';
comment on column public.case_event.source_type    is 'ACCIDENT=사고보고서 / RECALL_DOMESTIC=국내리콜(태깅 필요) / RECALL_OVERSEAS=해외리콜(Recall Hub 태깅 완료)';
comment on column public.case_event.raw_fields     is '서식이 통일되지 않은 항목의 임시 자리. 실물 검토 후 자주 쓰는 것만 컬럼으로 승격(8.1)';
comment on column public.case_event.is_confirmed   is '담당자 확정 여부. 확정 전에는 분석 대상이 아니다';

create index if not exists case_event_type_idx    on public.case_event (source_type);
create index if not exists case_event_item_idx    on public.case_event (item_name);
create index if not exists case_event_file_idx    on public.case_event (source_file_id);
create index if not exists case_event_confirm_idx on public.case_event (is_confirmed) where is_confirmed;

-- -----------------------------------------------------------------------------
-- 사건 코드화 결과 (L2)
--
-- clause_tag 와 같은 모양을 쓴다. 매칭이 양쪽의 같은 구조를 맞춰 보는 일이기 때문에,
-- 두 표의 컬럼이 어긋나면 매칭 SQL 이 지저분해진다.
-- -----------------------------------------------------------------------------
create table if not exists public.case_tag (
  id               bigint generated always as identity primary key,
  case_id          bigint not null references public.case_event(id) on delete cascade,
  axis             text not null check (axis in ('HF', 'DT')),
  code             varchar(30) not null,
  is_primary       boolean not null default false,
  confidence_score numeric check (confidence_score between 0 and 1),
  agreement_score  numeric check (agreement_score between 0 and 1),
  evidence_span    text,
  review_status    text not null default 'auto_unreviewed'
                     check (review_status in ('auto_unreviewed', 'approved', 'rejected', 'modified')),
  tagging_version  text not null,
  tagging_model    text,
  codebook_version text not null,
  created_at       timestamptz not null default now(),
  unique (case_id, axis, code, tagging_version)
);

comment on table  public.case_tag               is '사건에 붙은 HF/DT 코드. 조항 태깅과 같은 구조를 유지한다';
comment on column public.case_tag.is_primary    is '주된 위해요인 1개 필수 + 부차 복수 (PDR 4.3)';
comment on column public.case_tag.evidence_span is '원문에 없는 원인 추정을 막기 위해 required 로 강제한 항목(4.2 L2)';

create index if not exists case_tag_case_idx on public.case_tag (case_id);
create index if not exists case_tag_code_idx on public.case_tag (axis, code);

alter table public.source_file enable row level security;
alter table public.case_event  enable row level security;
alter table public.case_tag    enable row level security;
