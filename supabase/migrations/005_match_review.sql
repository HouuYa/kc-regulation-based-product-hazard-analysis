-- =============================================================================
-- 매칭 실행 · 결과 · 담당자 판단
--
-- 근거: 설계문서 §2.2, §2.3 결정 A, §5.6.3, §7.1 판단층, §7.2
--
-- 이 파일에는 이 체계에서 가장 값나가는 표가 들어 있다.
-- 표면적 산출물은 시험 후보군이지만, 장기적으로 더 큰 가치는 review_log 다(§10 특이관점).
-- 담당자 개인의 경험에 머물던 판단이 처음으로 구조화된 데이터로 쌓이는 자리이며,
-- §5.8 의 재현율·오탐률을 계산할 정답지도 여기서 나온다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 분석 1회의 실행 기록
--
-- 재실행 시 덮어쓰지 않고 새 run 을 쌓는다(§2.2).
-- config 를 함께 남기는 이유: §5.8 비교표는 "어느 구성이 나았는가"를 묻는데,
-- 어떤 구성으로 돌린 결과인지 남기지 않으면 표를 채울 수 없다.
-- -----------------------------------------------------------------------------
create table if not exists public.match_run (
  id              bigint generated always as identity primary key,
  case_id         bigint not null references public.case_event(id) on delete cascade,

  -- 켠 갈래 — §5.8 비교표의 행을 결정한다
  use_code        boolean not null default true,
  use_keyword     boolean not null default true,
  use_vector      boolean not null default true,
  use_context_header boolean not null default true,
  use_rerank      boolean not null default true,

  -- 융합 파라미터 (결정항목 10 — 하드코딩하지 않고 설정값으로)
  rrf_k           int     not null default 60,
  w_code          numeric not null default 0.5,
  w_code_partial  numeric not null default 0.2,

  candidate_count int not null default 20,
  embedding_model text,
  rerank_model    text,

  -- 결과 0건인 run 도 기록한다 (§2.3 결정 A)
  -- "대응 조항이 없음"이 그 자체로 산출물이기 때문 — 사각지대 목록의 원천이다
  result_count    int not null default 0,
  queried_hf_codes text[] not null default '{}',
  queried_dt_codes text[] not null default '{}',

  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  note            text
);

comment on table  public.match_run                   is '분석 1회의 실행 기록. 재실행 시 덮어쓰지 않고 새 run 을 쌓는다(2.2)';
comment on column public.match_run.use_code          is '§5.8 비교표를 채우기 위한 갈래 스위치. 한꺼번에 켜면 무엇이 효과를 냈는지 알 수 없다';
comment on column public.match_run.result_count      is '0 인 run 도 남긴다. "대응 조항 없음"이 1급 산출물이기 때문(2.3 결정 A)';
comment on column public.match_run.queried_hf_codes  is '어떤 코드로 조회했는데 없었는지를 남긴다. 사각지대 집계의 재료';

create index if not exists match_run_case_idx on public.match_run (case_id, started_at desc);

-- -----------------------------------------------------------------------------
-- 시험 후보 1건
--
-- 탈락 후보도 보존한다(§5.6.3).
-- 15건 중 10건이 리랭킹에서 탈락해도 기록은 남긴다 — 사각지대 분석에서
-- "검색에는 걸렸으나 관련성이 낮았던" 이력이 필요할 수 있기 때문이다.
-- -----------------------------------------------------------------------------
create table if not exists public.match_result (
  id            bigint generated always as identity primary key,
  run_id        bigint not null references public.match_run(id) on delete cascade,
  clause_id     bigint not null references public.clause(id) on delete cascade,

  -- 검색 단계 (①~④)
  search_score  numeric,
  match_path    text not null
                  check (match_path in ('CODE', 'CODE-PARTIAL', 'HYBRID', 'FALLBACK')),
  rank_code     int,
  rank_keyword  int,
  rank_vector   int,

  -- 리랭킹 단계 (⑤) — 점수·이유·모델을 모두 저장한다(§5.6.3)
  -- 저장본을 보여 주므로 LLM 리랭커를 쓰더라도 담당자에게는 항상 같은 결과다(§5.7)
  rerank_score  numeric,
  rerank_reason text,
  rerank_model  text,

  -- 최종 표시 순위. 탈락 후보는 is_shortlisted=false 로 남는다
  final_rank    int,
  is_shortlisted boolean not null default false,

  created_at    timestamptz not null default now(),
  unique (run_id, clause_id)
);

comment on table  public.match_result               is '시험 후보 목록. 탈락 후보도 보존한다(5.6.3)';
comment on column public.match_result.match_path    is 'CODE=HF·DT 모두 일치 / CODE-PARTIAL=상위 계위만 / HYBRID=코드 근거 없음 / FALLBACK=미태깅 품목';
comment on column public.match_result.rerank_reason is '왜 이 조항이 더 관련 있는가. 상용 리랭커는 점수만 주지만 LLM 방식은 이유를 준다(5.6.2)';
comment on column public.match_result.is_shortlisted is '상위 3~5건 기본 표시 대상. 나머지도 "더 보기"로 항상 열어 둔다(5.6.3)';

create index if not exists match_result_run_idx    on public.match_result (run_id, final_rank);
create index if not exists match_result_clause_idx on public.match_result (clause_id);

-- -----------------------------------------------------------------------------
-- 담당자 판단 — 이 체계의 핵심 자산 (§7.2)
--
-- 반려 사유를 선택지로 받는 이유: 자유 텍스트만 받으면 나중에 집계가 안 된다(§7.2).
-- 이 기록이 세 가지로 재사용된다 — 1단계 확인 사항의 측정 데이터, 매칭 가중치
-- 조정의 근거, 프롬프트 개선 시의 평가셋(정답지).
-- -----------------------------------------------------------------------------
create table if not exists public.review_log (
  id             bigint generated always as identity primary key,
  match_result_id bigint not null references public.match_result(id) on delete cascade,

  decision       text not null check (decision in ('ADOPTED', 'REJECTED', 'MODIFIED')),
  -- 집계 가능한 선택지. 자유 서술은 note 에 따로 받는다
  reject_reason  text check (reject_reason in (
                   'NOT_RELATED',      -- 관련 없음
                   'ALREADY_TESTED',   -- 이미 실시
                   'WRONG_CLAUSE',     -- 조항 오류
                   'LOW_PRIORITY'      -- 우선순위 낮음
                 )),
  note           text,
  reviewer       text,
  created_at     timestamptz not null default now(),

  -- 반려인데 사유가 없으면 집계에서 빈칸이 된다. 처음부터 막는다
  constraint review_log_reject_reason_required
    check (decision <> 'REJECTED' or reject_reason is not null)
);

comment on table  public.review_log               is '담당자의 채택·반려 기록. 이 체계에서 가장 값나가는 표(2.2·7.2)';
comment on column public.review_log.reject_reason is '집계 가능한 선택지로 받는다. 자유 텍스트만 받으면 나중에 집계가 안 된다(7.2)';
comment on column public.review_log.decision      is 'ADOPTED 가 정답, REJECTED 가 오탐. §5.8 재현율·오탐률이 이 컬럼에서 계산된다';

create index if not exists review_log_result_idx   on public.review_log (match_result_id);
create index if not exists review_log_decision_idx on public.review_log (decision, created_at);

alter table public.match_run    enable row level security;
alter table public.match_result enable row level security;
alter table public.review_log   enable row level security;
