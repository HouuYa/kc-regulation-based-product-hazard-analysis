-- =============================================================================
-- 조항 태깅 — HF/DT 코드 부여
--
-- 근거: 설계문서 §2.2 clause_tag, §5.2.1 태깅 산출 항목, §5.2.3 신뢰도 이원화
--
-- 이 표의 설계에서 가장 중요한 것은 신뢰도를 두 컬럼으로 나눈 점이다(§5.2.3).
--   confidence_score  LLM 자기보고 — 참고용. 틀린 답에도 0.9 를 주는 경우가 흔하다
--   agreement_score   같은 입력 3회 호출의 일치율 — 검수 정렬의 주 지표
--
-- 두 값이 엇갈리는 구간(자신 있다는데 답이 흔들림)이 가장 위험하며
-- 검수를 최우선 배치해야 할 지점이다(§10 11번).
-- =============================================================================

create table if not exists public.clause_tag (
  id               bigint generated always as identity primary key,
  clause_id        bigint not null references public.clause(id) on delete cascade,

  -- 축과 코드. HF/DT 를 한 표에 담되 axis 로 구분한다 —
  -- 조항 1건에 태그 N개를 허용해야 하므로(복수 코드, 컨셉 3.2) 행으로 푼다.
  axis             text not null check (axis in ('HF', 'DT')),
  code             varchar(30) not null,
  -- 주된 코드 1개 + 부차 코드 복수 (PDR §4.3 복수 코드 입력 원칙)
  is_primary       boolean not null default false,

  -- 두 가지 신뢰도를 분리 저장한다 (§5.2.3)
  confidence_score numeric check (confidence_score between 0 and 1),
  agreement_score  numeric check (agreement_score between 0 and 1),

  -- 근거 없는 코드 부여를 막기 위해 태깅 스키마에서 required 로 강제한 항목(§5.2.2)
  evidence_span    text,

  -- 검수 상태. 0단계 기본값은 '자동(미검수)' — 자동 확정 임계값은 실측 전에 정하지 않는다(결정항목 16)
  review_status    text not null default 'auto_unreviewed'
                     check (review_status in ('auto_unreviewed', 'approved', 'rejected', 'modified')),
  reviewed_by      text,
  reviewed_at      timestamptz,

  -- 언제 어떤 방식으로 붙은 코드인가 (§2.3 결정 B)
  tagging_version  text not null,
  tagging_model    text,
  codebook_version text not null,
  created_at       timestamptz not null default now(),

  unique (clause_id, axis, code, tagging_version)
);

comment on table  public.clause_tag                  is '조항에 붙은 HF/DT 색인. 조항 1건에 태그 N개(컨셉 3.2)';
comment on column public.clause_tag.confidence_score is 'LLM 자기보고 확신도. 참고용이며 이것만으로 검수 우선순위를 정하지 않는다(5.2.3)';
comment on column public.clause_tag.agreement_score  is '같은 입력을 3회 돌려 같은 코드가 나온 비율. 검수 정렬의 주 지표(5.2.3)';
comment on column public.clause_tag.evidence_span    is '그 코드를 붙인 근거 원문 구절. 검수 화면에서 하이라이트한다';
comment on column public.clause_tag.review_status    is '0단계는 전건 auto_unreviewed. 사람이 확정한 태깅은 자동 재태깅으로 덮어쓰지 않는다(3.3)';
comment on column public.clause_tag.tagging_version  is '프롬프트·모델·규칙 묶음의 판번호. 부분 재태깅이 가능해진다(2.3 결정 B)';
comment on column public.clause_tag.codebook_version is '어떤 코드북 판으로 붙였는가. 코드북 개정 시 영향 범위 산정에 쓴다';

create index if not exists clause_tag_clause_idx on public.clause_tag (clause_id);
-- 코드 갈래 검색의 핵심 인덱스 — 사건 코드로 조항을 역인출한다
create index if not exists clause_tag_code_idx   on public.clause_tag (axis, code);
-- 검수 대기열 정렬 (반복 일치도가 낮은 순)
create index if not exists clause_tag_queue_idx  on public.clause_tag (review_status, agreement_score);

alter table public.clause_tag enable row level security;

-- -----------------------------------------------------------------------------
-- 태깅 실행 기록 — 어떤 설정으로 돌린 배치인가
-- 프롬프트·모델을 바꾼 뒤 검수 완료분으로 성능을 비교하려면(§3.3) 이 기록이 필요하다.
-- -----------------------------------------------------------------------------
create table if not exists public.tagging_run (
  id               bigint generated always as identity primary key,
  tagging_version  text not null,
  target_scope     text,
  model            text,
  repeat_count     int,
  codebook_version text,
  prompt_sha256    text,
  clause_count     int not null default 0,
  ok_count         int not null default 0,
  fail_count       int not null default 0,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  note             text
);

comment on table public.tagging_run is '태깅 배치 1회의 실행 조건. 모델·프롬프트 교체 시 성능 비교의 기준선이 된다(3.3)';

alter table public.tagging_run enable row level security;
