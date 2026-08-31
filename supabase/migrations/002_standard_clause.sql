-- =============================================================================
-- 안전기준 · 조항 · 시험조건 · 조항 연결
--
-- 근거: 설계문서 §2.1 ERD, §2.2 테이블별 역할
--
-- 실물 파싱으로 확인한 사실이 스키마에 반영되어 있다.
--   - 조항 계위가 가변이고 부(제1부~제3부, 부록 A~F)로 나뉜다 → part 컬럼 필수
--   - 성능요건↔시험방법 연결이 본문 참조와 표의 시험방법 열에 들어 있다 → clause_link
--   - 참조 대상이 다른 기준에 있는 경우가 88건 있다 → to_clause_id 를 NULL 허용
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 안전기준 (문서 1건)
-- -----------------------------------------------------------------------------
create table if not exists public.standard (
  id              bigint generated always as identity primary key,
  source_filename text not null,
  -- 같은 파일 재적재 판별. 내용이 같으면 다시 넣지 않는다
  source_sha256   text not null,
  cert_scheme     text,
  annex_no        text,
  item_name       text,
  standard_no     text,
  display_name    text not null,
  -- 기준 개정 대비. 개정되면 새 행을 만들고 옛 행은 지우지 않는다(§2.2)
  version         text,
  effective_date  date,
  is_current      boolean not null default true,
  total_pages     int,
  parser_model    text,
  ocr_confidence  numeric,
  loaded_at       timestamptz not null default now(),
  unique (source_sha256)
);

comment on table  public.standard             is '안전기준 문서 1건. 개정 시 새 행을 만들고 옛 행은 보존한다(2.2)';
comment on column public.standard.cert_scheme is '안전인증 / 안전확인 / 공급자적합성 / 안전기준준수 / 전기용품';
comment on column public.standard.item_name   is '품목명. 매칭 시 품목 한정에 쓴다(5.5 target_item)';
comment on column public.standard.is_current  is 'false 면 개정 전 판. 매칭 기본 대상에서 제외한다';

create index if not exists standard_item_idx    on public.standard (item_name);
create index if not exists standard_current_idx on public.standard (is_current) where is_current;

-- -----------------------------------------------------------------------------
-- 조항 — 이 체계의 검색 단위
--
-- 설계문서 §5.2.5: 일반 RAG 의 최대 난제인 "몇 글자로 자를 것인가"가 여기서는
-- 발생하지 않는다. 표준 문서의 계위가 이미 의미 단위를 정해 두었기 때문이다.
-- -----------------------------------------------------------------------------
create table if not exists public.clause (
  id               bigint generated always as identity primary key,
  standard_id      bigint not null references public.standard(id) on delete cascade,
  marker           text not null,
  part             text,
  breadcrumb_path  text,
  level_code       text,
  level_name       text,
  clause_type      text,
  title_raw        text,
  body             text not null default '',
  page_no          int,
  parse_confidence numeric,
  order_index      int not null default 0,

  -- ---------------------------------------------------------------------------
  -- 검색을 위해 추가되는 컬럼 (설계문서 §2.2 "검색을 위해 clause 에 추가되는 컬럼")
  --
  -- 만드는 순서에 유의한다. search_text 는 태깅 결과(chunk_summary)를 재료로 쓰므로
  -- 태깅이 끝난 뒤에 조립되고, 임베딩은 그다음이다. 태깅을 고치면 조립과 임베딩을
  -- 다시 해야 한다(§3.4).
  -- ---------------------------------------------------------------------------
  context_header   text,
  chunk_summary    text,
  keywords         text[] not null default '{}',
  search_text      text,
  search_text_variant text,
  embedding        extensions.vector(1536),
  embedding_model  text,
  embedded_at      timestamptz,

  unique (standard_id, part, marker)
);

comment on table  public.clause                    is '안전기준 조항. 조항 하나가 곧 검색 한 조각이다(5.2.5)';
comment on column public.clause.marker             is '조항번호 — 예: 4.3.3, D.1';
comment on column public.clause.part               is '부 — 제1부/제2부/제3부/부록 A. 같은 번호라도 부가 다르면 다른 조항이다';
comment on column public.clause.breadcrumb_path    is '계위 경로 — 예: 제1부 > 4 > 4.3 > 4.3.3';
comment on column public.clause.title_raw          is '파싱기가 준 제목 원문. 본문으로 흘러넘친 경우가 많아 참고용으로만 쓴다';
comment on column public.clause.context_header     is '품목·계위·분류명을 조합한 머리말. 색인 대상 텍스트의 맨 앞에 붙는다(5.2.4)';
comment on column public.clause.chunk_summary      is '검색용 한 줄 요약. 이 조항이 무엇을 막으려는 규정인지 한 문장(5.2.1)';
comment on column public.clause.keywords           is 'LLM 이 뽑은 용어·동의어·수치. 사고의 "넘어짐"과 기준의 "전도"를 잇는다(4.2)';
comment on column public.clause.search_text        is '머리말 + 한 줄 요약 + 본문 + 시험조건을 결합한 색인 대상(5.2.4)';
comment on column public.clause.search_text_variant is '조립 규칙 변형 식별자(A/B/C). 결정항목 9 를 0단계에서 비교하기 위함';
comment on column public.clause.embedding          is '검색용 텍스트의 벡터. 원문 청크가 아니라 조립한 텍스트를 임베딩한다(10장 8번)';
comment on column public.clause.embedding_model    is '어떤 모델로 만든 벡터인가. 없으면 모델 교체 시 좌표계가 섞여 검색이 조용히 망가진다(2.2)';

create index if not exists clause_standard_idx on public.clause (standard_id);
create index if not exists clause_marker_idx   on public.clause (standard_id, marker);
create index if not exists clause_order_idx    on public.clause (standard_id, order_index);

-- -----------------------------------------------------------------------------
-- 시험조건 — 하중값·방향·치수 등 (컨셉 5.1 의 핵심 산출 항목)
--
-- 실물에서 표의 <table> HTML 로 들어온다. 항목/허용치/시험방법 열을 가진 표만
-- 시험조건으로 본다(목차·요약표를 걸러내기 위함).
-- -----------------------------------------------------------------------------
create table if not exists public.test_condition (
  id                 bigint generated always as identity primary key,
  clause_id          bigint not null references public.clause(id) on delete cascade,
  item_group         text,
  item_name          text not null,
  allowance_raw      text,
  value_num          numeric,
  unit               text,
  -- 이 항목의 시험방법 조항번호. clause_link 로도 별도 적재된다
  test_method_marker text,
  source             text not null default 'TABLE' check (source in ('TABLE', 'TEXT')),
  created_at         timestamptz not null default now()
);

comment on table  public.test_condition            is '시험조건. 파싱 데이터의 표 서술이 여기로 들어온다(2.2)';
comment on column public.test_condition.item_group is '상위 항목 — 예: 유해 원소 용출';
comment on column public.test_condition.value_num  is '허용치에서 분리한 수치. 원문은 allowance_raw 에 그대로 둔다';

create index if not exists test_condition_clause_idx on public.test_condition (clause_id);

-- -----------------------------------------------------------------------------
-- 조항 연결 — 성능요건 ↔ 시험방법 (설계문서 결정항목 1)
--
-- 설계문서는 "파싱 데이터에 이 관계가 이미 있는지가 큰 분기점(없으면 별도 구축 필요)"
-- 이라 했다. 실물을 열어 보니 전용 필드는 없지만 두 곳에 사실상 들어 있어
-- 자동 추출이 가능하다 — link_source 가 그 출처를 구분한다.
--
-- to_clause_id 가 NULL 인 행이 정상적으로 존재한다.
-- KC 60335-2-x 계열은 제1부(KC 60335-1)를 고쳐 쓰는 부분 표준이라 참조 대상이
-- 다른 기준에 있다. 버리지 않고 남겨야 나중에 기준 간 연결을 이을 수 있다.
-- -----------------------------------------------------------------------------
create table if not exists public.clause_link (
  id             bigint generated always as identity primary key,
  from_clause_id bigint not null references public.clause(id) on delete cascade,
  to_clause_id   bigint references public.clause(id) on delete set null,
  -- 대상 조항번호 원문. 미해결 참조는 이것만 남는다
  to_marker      text not null,
  link_type      text not null check (link_type in ('TEST_METHOD', 'REFERENCE')),
  link_source    text not null check (link_source in ('TABLE', 'TEXT')),
  evidence_span  text,
  created_at     timestamptz not null default now(),
  unique (from_clause_id, to_marker, link_source)
);

comment on table  public.clause_link              is '성능요건 조항 ↔ 시험방법 조항 연결. "4.3.3 → 5.9.2" 관계(2.2)';
comment on column public.clause_link.to_clause_id is 'NULL 이면 미해결 참조 — 대상이 다른 기준에 있다(KC 60335 계열)';
comment on column public.clause_link.link_source  is 'TABLE=표의 시험방법 열 / TEXT=본문의 "…에 따라 시험" 참조';
comment on column public.clause_link.evidence_span is '그 판단의 근거가 된 원문 구절. 화면에서 근거로 제시한다';

create index if not exists clause_link_from_idx on public.clause_link (from_clause_id);
create index if not exists clause_link_to_idx   on public.clause_link (to_clause_id);

-- -----------------------------------------------------------------------------
-- 접근 통제 — 001_codebook_schema.sql 과 같은 이유
--
-- RLS 를 켜고 정책은 만들지 않는다. anon·authenticated 는 전부 차단되고
-- 서버(service_role)만 접근한다. 설계문서 1.3.3 "프론트엔드가 DB 에 직접 붙지
-- 않는다"를 DB 차원에서 강제한 것이다.
-- -----------------------------------------------------------------------------
alter table public.standard       enable row level security;
alter table public.clause         enable row level security;
alter table public.test_condition enable row level security;
alter table public.clause_link    enable row level security;
