-- =============================================================================
-- 2차원 위해요인 분류 코드북 — 스키마
--
-- 근거 문서
--   01_사전분석_구현설계_v0.6.md §2.4 (코드북 독립 서비스)
--   제품_위해요인_분류체계_정립_PDR_v0_9_7.md 부록 A (마스터 테이블)
--
-- 배치 결정
--   지금은 본 체계와 같은 Project 의 codebook 스키마에 둔다.
--   조회 함수는 public 스키마에 두어(002 참조) PostgREST 가 바로 노출하고,
--   나중에 별도 Project 로 분리해도 이용 시스템의 호출부는 그대로다.
--
-- 설계 결정 두 가지 (설계문서 ERD 와 다른 부분 — 의도적)
--   1) PK 는 uuid 가 아니라 bigint identity 를 쓴다.
--      랜덤 UUID(v4)는 인덱스가 흩어져 삽입·조회가 느려진다. 코드북과 조항은
--      외부에 노출되지 않고 서버만 접근하므로 추측 불가능한 ID 가 필요 없다.
--   2) 컬럼명은 한글이 아니라 영문 snake_case + 한글 주석이다.
--      한글 식별자는 모든 SQL 에서 큰따옴표 인용이 필요해 함수·인덱스가 번거롭고,
--      Recall Hub 의 기존 컬럼(hazard_factor_code 등)과 축을 맞추기도 어렵다.
--
-- 버전이 왜 모든 표의 키에 들어가는가 (§2.4.3)
--   "버전 없이 지금 코드 목록만 주면, 과거 태깅이 어떤 정의로 붙었는지 되짚을 수 없다."
--   그래서 코드 표의 PK 는 (version_id, code) 다.
-- =============================================================================

create schema if not exists codebook;

comment on schema codebook is
  '2차원 위해요인 분류 코드북. 정의가 한 곳에만 있어야 공통 언어가 성립한다(설계문서 2.4.1)';

-- -----------------------------------------------------------------------------
-- 코드북 버전
-- -----------------------------------------------------------------------------
create table if not exists codebook.version (
  id              bigint generated always as identity primary key,
  version         text not null unique,
  effective_date  date,
  -- draft: 적재만 됨 / active: 현재 유효 / superseded: 후속 버전에 밀림
  status          text not null default 'draft'
                    check (status in ('draft', 'active', 'superseded')),
  source_filename text,
  -- 같은 파일을 두 번 올렸는지 판별 (§8.2 중복 방지)
  source_sha256   text,
  note            text,
  created_at      timestamptz not null default now()
);

comment on table  codebook.version              is '코드북 개정 이력. 확정 시 새 버전으로 등록하고 기존 버전은 덮어쓰지 않는다(8.2)';
comment on column codebook.version.version      is '버전 문자열 — 예: v0.9.7';
comment on column codebook.version.status       is 'draft(적재됨) / active(현재 유효) / superseded(후속 버전에 밀림)';
comment on column codebook.version.source_sha256 is '원본 MD 파일 해시. 같은 파일 재업로드 판별용';

-- 유효 버전은 동시에 하나만 존재해야 한다. get_current_version() 이 이것에 의존한다.
create unique index if not exists version_single_active_idx
  on codebook.version ((status)) where status = 'active';

-- -----------------------------------------------------------------------------
-- 위해요인(HF) 코드 — 원인 축
-- -----------------------------------------------------------------------------
create table if not exists codebook.hazard_factor (
  version_id       bigint not null references codebook.version(id) on delete cascade,
  code             varchar(30) not null,
  mshell_level1    varchar(10) not null
                     check (mshell_level1 in ('H','S','M','E','L0','L1','UNKNOWN')),
  category_l2      varchar(20),
  category_l3      varchar(20),
  -- HF.UNKNOWN=2 / HF.M.DES=3 / HF.H.ELEC.NPC=4 — 실물 확인 결과 계위가 가변이다
  depth            smallint not null check (depth between 2 and 4),
  -- 상위 코드. CODE-PARTIAL 매칭(5.4)과 화면 트리에 쓴다
  parent_code      varchar(30),
  name_ko          text not null,
  name_en          text,
  definition       text,
  mshell_link      text,
  example          text,
  is_recall_common boolean not null default true,
  is_active        boolean not null default true,
  -- 폐지 코드의 대체 코드. resolve_code() 가 자동 치환에 쓴다(§2.4.3)
  replaced_by      varchar(30),
  source_section   text,
  primary key (version_id, code)
);

comment on table  codebook.hazard_factor                  is '위해요인(원인) 코드. PDR §5';
comment on column codebook.hazard_factor.code             is '점 표기 코드 — 예: HF.H.ELEC.NPC (PDR §4.2)';
comment on column codebook.hazard_factor.mshell_level1    is 'M-SHELL 대분류 — H/S/M/E/L0/L1/UNKNOWN';
comment on column codebook.hazard_factor.depth            is '계위 깊이. HF.UNKNOWN=2, HF.M.DES=3, HF.H.ELEC.NPC=4';
comment on column codebook.hazard_factor.parent_code      is '상위 코드. 코드 상위계위 일치(CODE-PARTIAL) 판정에 쓴다';
comment on column codebook.hazard_factor.is_recall_common is 'false 면 기본 선택 목록에 노출하지 않는다. L0·L1 이 해당(PDR 부록 A 비고)';
comment on column codebook.hazard_factor.source_section   is '이 코드를 정의한 PDR 절. 근거 추적용';

create index if not exists hazard_factor_level1_idx on codebook.hazard_factor (version_id, mshell_level1);
create index if not exists hazard_factor_parent_idx on codebook.hazard_factor (version_id, parent_code);

-- -----------------------------------------------------------------------------
-- 피해유형(DT) 코드 — 결과 축
--
-- HF 와 한 표에 담지 않는 이유(§2.4.4): 두 축의 속성이 다르다.
-- DT 만 ISO 5665 심각도 범위·PRISM 등급·EU Safety Gate 대응을 갖는다.
-- -----------------------------------------------------------------------------
create table if not exists codebook.damage_type (
  version_id         bigint not null references codebook.version(id) on delete cascade,
  code               varchar(30) not null,
  dt_group           varchar(15) not null
                       check (dt_group in ('THERMAL','ELECTRIC','MECHANICAL','ASPHYX',
                                           'CHEMICAL','BODY','NON-PHYS','OTHER')),
  name_ko            text not null,
  name_en            text,
  definition         text,
  severity_min       smallint check (severity_min between 0 and 5),
  severity_max       smallint check (severity_max between 0 and 5),
  prism_risk_level   text,
  eu_safetygate_type text,
  is_active          boolean not null default true,
  replaced_by        varchar(30),
  source_section     text,
  primary key (version_id, code),
  constraint damage_type_severity_order check (
    severity_min is null or severity_max is null or severity_min <= severity_max
  )
);

comment on table  codebook.damage_type                    is '피해유형(결과) 코드. PDR §6';
comment on column codebook.damage_type.severity_min       is 'ISO 5665:2024 심각도 하한 (0=아차사고 ~ 5=사망)';
comment on column codebook.damage_type.severity_max       is 'ISO 5665:2024 심각도 상한. 최악 시나리오 우선 원칙(PDR §6.3)의 재료';
comment on column codebook.damage_type.eu_safetygate_type is 'EU Safety Gate Type of Risk 대응 (PDR §6.4)';

create index if not exists damage_type_group_idx on codebook.damage_type (version_id, dt_group);

-- -----------------------------------------------------------------------------
-- 코드 조합 제약
--
-- PDR §0.4·§4.4: L0·L1 은 단독 사용 금지 — HF.M.DES 또는 HF.M.QMS 와 반드시 병기.
-- 이 표가 있어야 validate_code_set() 이 규칙을 코드가 아닌 데이터로 검증할 수 있다.
-- 규칙을 애플리케이션에 박아 두면 코드북이 개정될 때 따라 고쳐야 한다.
-- -----------------------------------------------------------------------------
create table if not exists codebook.code_constraint (
  id              bigint generated always as identity primary key,
  version_id      bigint not null references codebook.version(id) on delete cascade,
  subject_prefix  varchar(30) not null,
  rule_type       text not null check (rule_type in ('REQUIRES_ANY_OF','RECOMMENDS_ANY_OF')),
  requires_any_of text[] not null default '{}',
  reason          text,
  source_section  text,
  unique (version_id, subject_prefix, rule_type)
);

comment on table  codebook.code_constraint                is '코드 조합 제약. 설계문서 2.4.4 "조합 제약을 표로 만들어 resolve_code 가 검증하게 함"';
comment on column codebook.code_constraint.subject_prefix is '제약이 걸리는 코드 접두사 — 예: HF.L0';
comment on column codebook.code_constraint.rule_type      is 'REQUIRES_ANY_OF=위반이면 저장 거부 / RECOMMENDS_ANY_OF=경고만';

create index if not exists code_constraint_version_idx on codebook.code_constraint (version_id);

-- -----------------------------------------------------------------------------
-- 코드별 키워드 (PDR 부록 G)
--
-- 쓰임이 두 가지다.
--   1) 키워드 갈래 검색의 씨앗 — 사고는 "넘어짐", 기준은 "전도" 로 쓴다(설계문서 4.2)
--   2) L1·L2 태깅 프롬프트에 코드별 예시 용어로 넣는다
-- -----------------------------------------------------------------------------
create table if not exists codebook.code_keyword (
  version_id     bigint not null references codebook.version(id) on delete cascade,
  axis           text not null check (axis in ('HF','DT')),
  code           varchar(30) not null,
  keyword        text not null,
  keyword_group  text,
  source_section text,
  primary key (version_id, axis, code, keyword)
);

comment on table codebook.code_keyword is 'AI 분류 학습용 키워드 사전. PDR 부록 G';

create index if not exists code_keyword_code_idx on codebook.code_keyword (version_id, code);

-- -----------------------------------------------------------------------------
-- 접근 통제
--
-- 0단계는 권한 체계를 만들지 않는다(§9). 그러나 Supabase 는 anon 키만 있으면
-- PostgREST 로 표에 바로 닿을 수 있으므로, RLS 를 켜 두지 않으면 "권한 미구현"이
-- "전면 공개"가 된다.
--
-- 그래서 RLS 를 켜되 정책은 만들지 않는다 → anon·authenticated 는 전부 차단.
-- 서버(service_role)는 RLS 를 우회하므로 배치·API 는 그대로 동작한다.
-- 이는 설계문서 1.3.3 "프론트엔드가 DB 에 직접 붙지 않는다"를 DB 차원에서 강제한 것이다.
-- 조회가 필요한 이용 시스템은 002 의 조회 전용 함수로만 접근한다(§2.4.3).
-- -----------------------------------------------------------------------------
alter table codebook.version         enable row level security;
alter table codebook.hazard_factor   enable row level security;
alter table codebook.damage_type     enable row level security;
alter table codebook.code_constraint enable row level security;
alter table codebook.code_keyword    enable row level security;
