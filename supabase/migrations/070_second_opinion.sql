-- =============================================================================
-- 사고보고서 병행 점검(2차 소견) 계층
--
-- 왜 만드는가
--   지금 체계는 사고조사보고서를 그대로 받아 적는다. 보고서가 "제품 시험 결과 모두
--   적합"으로 끝나면 원인 코드는 HF.UNKNOWN 이 되고(71건 중 54건, 76%) 그 사건은
--   사실상 분석에서 빠진다. 이것은 버그가 아니라 설계대로다 — v0.6 §5.2.2 가
--   "원문에 없는 원인을 추정하지 않는다"를 evidence_span 필수로 못박아 두었다.
--
--   문제는 거기서 멈춘다는 것이다. 올라온 보고서는 전부 사람이 검수해 종결한 건이므로,
--   보고서의 결론은 확인해야 할 주장이지 복사해 올 정답이 아니다.
--
-- 무엇을 근거로 삼는가 (2026-09-11 사고보고서 71건 전량 실측)
--   70건(99%)이 narrative 안에 「조사 방법」 줄로 수행한 시험을 스스로 열거한다.
--   64건(90%)에 동일성 확인 절, 46건(65%)이 「적합/충족」 결론,
--   42건(59%)에 상이·불일치·미표시 같은 불법 신호, 12건(17%)이 (비대상) 품목,
--   59건(83%)에 단위 붙은 측정값이 있다.
--
--   핵심은 이것이다 — "적합"은 시험한 범위 안에서만 적합이고, 그 범위를 보고서가
--   스스로 적어 놓았다. 사건 5614(전기주전자)는 유리 본체가 최초 사용 중 파열됐는데
--   기계적 강도·열 충격 두 가지만 시험하고 "모두 요구사항 충족"으로 끝났다.
--   사건 5607(종아리마사지기)은 최대 56.6℃ 로 적합인데 피해자는 2도·3도 화상을 입었다.
--
-- 지키는 선 네 개 (깨면 설계가 무너진다)
--   1. case_tag 에 한 줄도 쓰지 않는다. 추정 코드는 second_opinion_finding 에만 산다.
--      HF.UNKNOWN 54건은 "조사가 원인을 밝히지 못했다"는 사실의 기록이고, 추정으로
--      덮으면 그 사실 자체가 데이터에서 사라진다 (04-1 §7).
--   2. match_run/match_result 에 쓰지 않는다. 04-1 §8 실측 — 원인 다리를 기본 검색에
--      자동 반영했더니 재현율이 16.2%→13.1% 로 떨어졌다. 별도 표·별도 목록이다.
--   3. 불량과 불법을 표 구조로 가른다 (CLAUDE.md §10). output_kind 가 그 분리선이다.
--   4. evidence_span 은 저장 직전 코드가 narrative 부분문자열인지 다시 검사한다.
--      스키마 required 와 프롬프트 지시는 모델의 협조에 기대는 것이고, 그 검사만이
--      실제 집행이다. 통과 못 한 것은 버리고 개수를 run 에 남긴다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 한 번의 병행 점검 실행
--
-- match_run 과 같은 철학이다 — 덮어쓰지 않고 쌓으며, 그때의 입력·설정·분모를
-- 스스로 들고 있는다. 나중에 "그때 왜 이 소견을 냈나"를 되짚으려면 그 시점의
-- 값이 남아 있어야 한다.
-- -----------------------------------------------------------------------------
create table if not exists public.second_opinion_run (
  id                        bigint generated always as identity primary key,
  case_id                   bigint not null references public.case_event(id) on delete cascade,
  started_at                timestamptz not null default now(),
  finished_at               timestamptz,

  -- 어느 방식으로 냈는가. 안 남기면 A/B 실측이 뒤섞인다 (CLAUDE.md §6)
  extract_variant           text not null default 'LLM'  check (extract_variant in ('LLM', 'REGEX', 'BOTH')),
  gap_scope                 text not null default 'SECTION' check (gap_scope in ('SECTION', 'CLAUSE')),
  recall_match              text not null default 'BOTH' check (recall_match in ('VECTOR', 'GPC', 'BOTH', 'NONE')),

  -- 그때의 분모. standardsForCase() 는 용어 사전·검수 상태가 바뀌면 답이 달라져서,
  -- 나중에 다시 불러도 그때 분모를 재현할 수 없다. 통째로 박아 둔다
  standard_ids              bigint[] not null default '{}',
  scope_method              text,
  scope_evidence            text,

  -- 분모의 크기. 공백 개수만 보면 뜻이 없다 — "47개 중 6개"여야 말이 된다
  requirement_clause_count  integer not null default 0,
  requirement_section_count integer not null default 0,

  -- 분자. 매핑 실패(unmapped)를 공백과 섞지 않으려고 따로 센다.
  -- 이 계층에서 가장 조용히 틀릴 수 있는 자리다 — 시험명을 못 맞히면 분자가 0이 되어
  -- "전부 공백"이라는 가장 위험한 거짓 산출물이 나온다
  performed_test_count      integer not null default 0,
  mapped_test_count         integer not null default 0,
  unmapped_test_count       integer not null default 0,

  gap_section_count         integer not null default 0,
  -- 인용 검사에서 버린 항목 수 = 추출 품질 지표
  dropped_span_count        integer not null default 0,

  extract_model             text,
  extract_agreement         numeric check (extract_agreement between 0 and 1),
  prompt_version            text,
  codebook_version          text,

  -- 사진에서 건진 재료를 썼는가. 3단계에서 대조군 비교에 쓴다
  photo_evidence_used       boolean not null default false,
  vision_prompt_variant     text,

  notes                     text
);

comment on table  public.second_opinion_run is
  '사고보고서 병행 점검 한 번의 실행. match_run 과 달리 기본 조항 검색을 건드리지 않는다';
comment on column public.second_opinion_run.standard_ids is
  '그때의 분모. standardsForCase() 는 시점마다 답이 달라지므로 재현하려면 박아 둬야 한다';
comment on column public.second_opinion_run.unmapped_test_count is
  '보고서가 수행했다고 적었으나 조항으로 못 맞힌 시험 수. 공백과 절대 섞지 않는다';

create index if not exists second_opinion_run_case_idx on public.second_opinion_run (case_id, started_at desc);

-- -----------------------------------------------------------------------------
-- 보고서가 스스로 말한 것 (추출된 사실 — 소견이 아니다)
--
-- 추출과 소견을 나누는 이유: 추출은 한 번이면 되고 소견 규칙은 자주 바뀐다.
-- 규칙을 고칠 때마다 LLM 을 다시 부르면 71건 × 반복이 매번 돈이 된다.
-- -----------------------------------------------------------------------------
create table if not exists public.case_investigation_item (
  id             bigint generated always as identity primary key,
  run_id         bigint not null references public.second_opinion_run(id) on delete cascade,
  case_id        bigint not null references public.case_event(id) on delete cascade,

  item_type      text not null check (item_type in
                   ('TEST_PERFORMED', 'IDENTITY_CHECK', 'CONCLUSION',
                    'MEASUREMENT', 'NON_TARGET', 'MARKING_NOTE')),

  -- 원문 표기 그대로("기계적 강도"). normalized 는 조항 제목과 맞춰 보기 위한 정규화형
  label          text not null,
  normalized     text,

  verdict        text check (verdict in
                   ('적합', '부적합', '판정없음', '미상',
                    '동일함', '상이함', '확인불가', '해당없음',
                    '원인미상', '비대상', '기타')),

  value_num      numeric,
  unit           text,

  -- not null 이 구조적 강제의 마지막 못이다 (선 4)
  evidence_span  text not null,
  -- narrative 부분문자열 검사 통과 여부. false 면 화면에서 등급을 낮춘다
  span_verified  boolean not null default false,

  extract_source text not null default 'LLM' check (extract_source in ('LLM', 'REGEX', 'PHOTO')),
  confidence     numeric check (confidence between 0 and 1),
  created_at     timestamptz not null default now()
);

comment on table  public.case_investigation_item is
  '사고보고서가 스스로 말한 것 — 수행한 시험·동일성 결론·최종 결론·측정값. 우리 판단이 아니다';
comment on column public.case_investigation_item.span_verified is
  '원문 부분문자열 검사 통과 여부. 스키마 required 는 모델의 협조이고 이 칸만이 기계 판정이다';

create index if not exists case_investigation_item_case_idx on public.case_investigation_item (case_id, item_type);
create index if not exists case_investigation_item_run_idx  on public.case_investigation_item (run_id);

-- -----------------------------------------------------------------------------
-- 소견
-- -----------------------------------------------------------------------------
create table if not exists public.second_opinion_finding (
  id                   bigint generated always as identity primary key,
  run_id               bigint not null references public.second_opinion_run(id) on delete cascade,
  case_id              bigint not null references public.case_event(id) on delete cascade,

  finding_type         text not null check (finding_type in
                         ('TEST_GAP', 'LEGAL_SIGNAL', 'RECALL_EVIDENCE',
                          'STANDARD_GAP', 'SELF_INCONSISTENCY')),

  -- 불량과 불법의 분리선 (CLAUDE.md §10). TEST_ITEM 에 MARKING 조항이 섞이면 안 된다 —
  -- 표시 의무 위반은 시험으로 확인하는 것이 아니라 법령을 보면 판정된다
  output_kind          text not null check (output_kind in
                         ('TEST_ITEM', 'CERT_MARKING_CHECK', 'REFERENCE', 'POLICY_SIGNAL')),

  rank                 integer,
  score                numeric,

  -- 조항 또는 절을 가리킨다. 절 단위 공백이면 clause_id 는 null 이고 section_marker 가 찬다
  standard_id          bigint references public.standard(id) on delete set null,
  clause_id            bigint references public.clause(id)   on delete set null,
  section_marker       text,
  part                 text,
  -- clause_link 를 따라간 결과 — "그래서 무슨 시험을 의뢰하나"의 답
  test_method_clause_id bigint references public.clause(id)  on delete set null,

  -- 코드북은 논리 참조가 규약이라 FK 를 걸지 않는다 (snapshot.ts 주석)
  hf_code              varchar(30),
  dt_code              varchar(30),
  -- 이 행의 코드가 확정이 아님을 데이터가 스스로 말한다.
  -- 나중에 "소견 코드를 확정 태그로 올리자"는 편의 기능이 붙으면 04-1 §7 의 선이
  -- 깨지는데, 표 구조로는 막을 수 없어 칸과 주석으로 이유를 박아 둔다
  code_is_estimated    boolean not null default true,
  cause_route          text check (cause_route in ('TEST', 'LEGAL', 'GAP', 'OTHER')),

  -- 유사 리콜 사례
  ref_case_id          bigint references public.case_event(id) on delete set null,
  similarity           numeric,
  gpc_match_level      text check (gpc_match_level in ('BRICK', 'CLASS', 'FAMILY', 'SEGMENT', 'NONE')),

  -- 통계 다리에서 온 근거. 분모(sample_size)를 반드시 함께 저장한다 —
  -- 화면에 "59%"만 보이면 "이 사건이 과열일 확률"로 읽힌다
  support              integer,
  confidence           numeric,
  lift                 numeric,
  sample_size          integer,

  rationale            text not null,
  evidence_span        text,
  -- 사각지대는 전문가가 확인한 건만 정책 신호가 된다 (v0.7 §7.8)
  needs_expert_confirm boolean not null default true,
  created_at           timestamptz not null default now()
);

comment on table  public.second_opinion_finding is
  '병행 점검 소견. 기본 조항 목록(match_result)을 덮어쓰지 않는 별도 목록이다';
comment on column public.second_opinion_finding.output_kind is
  '불량(TEST_ITEM)과 불법(CERT_MARKING_CHECK)의 분리선. 표시 위반은 시험항목으로 내보내지 않는다';
comment on column public.second_opinion_finding.code_is_estimated is
  '항상 true. 이 코드를 case_tag 로 올리면 04-1 §7 "통계적 추측이 조사 결과로 굳으면 안 된다"가 깨진다';

create index if not exists second_opinion_finding_case_idx on public.second_opinion_finding (case_id, finding_type, rank);
create index if not exists second_opinion_finding_run_idx  on public.second_opinion_finding (run_id);

-- -----------------------------------------------------------------------------
-- 담당자 판정 (append-only, review_log 와 같은 모양)
--
-- 시험 범위 공백은 정답지가 없다 — 정답셋 47건은 "보고서가 실제로 수행한 시험"이라
-- 공백은 정의상 그 밖이다. 그래서 담당자 채택률이 이 계층의 유일한 성적표이고,
-- 1단계부터 세고 있어야 한다.
-- -----------------------------------------------------------------------------
create table if not exists public.second_opinion_review (
  id            bigint generated always as identity primary key,
  finding_id    bigint not null references public.second_opinion_finding(id) on delete cascade,
  decision      text not null check (decision in ('ACCEPTED', 'HOLD', 'REJECTED')),
  reject_reason text,
  note          text,
  reviewer      text,
  created_at    timestamptz not null default now()
);

comment on table public.second_opinion_review is
  '소견에 대한 담당자 판정. 덮어쓰지 않고 쌓는다 — 판단이 바뀐 경위도 근거다';

create index if not exists second_opinion_review_finding_idx on public.second_opinion_review (finding_id, created_at desc);

alter table public.second_opinion_run     enable row level security;
alter table public.case_investigation_item enable row level security;
alter table public.second_opinion_finding enable row level security;
alter table public.second_opinion_review  enable row level security;

-- -----------------------------------------------------------------------------
-- 이 사고와 닮은 리콜 사례를 찾는다
--
-- 왜 새로 만드나
--   case_event.embedding 은 채워져 있는데 저장소 전체에서 조회하는 코드가 한 줄도
--   없다. <=> 는 clause(007)와 gpc_brick(043)에만 쓰인다. 담당자가 "사고조사 원인
--   분석에 해외 리콜도 같이 검색·분석하라"고 한 것이 이 함수 없이는 성립하지 않는다.
--
-- 왜 색인을 안 만드나
--   case_event 가 2,400행 안팎이라 정확 스캔이 hnsw 근사보다 빠르고 정확하다.
--   행이 만 단위로 늘면 그때 색인을 판단한다.
--
-- 판단은 SQL 이 한다 (설계문서 §1.1 원칙 2). GPC 계층 일치는 벡터 유사도에 얹는
-- 값싼 구조적 필터다 — 임베딩이 품목이 아니라 사고 문체를 보고 있을 때 걸러 준다.
-- -----------------------------------------------------------------------------
create or replace function public.similar_recall_cases(
  p_embedding    extensions.vector(1536),
  p_gpc_segment  text default null,
  p_gpc_family   text default null,
  p_gpc_class    text default null,
  p_gpc_brick    text default null,
  p_limit        integer default 10,
  p_require_gpc  boolean default false
)
returns table (
  case_id         bigint,
  similarity      numeric,
  gpc_match_level text,
  source_type     text
)
language sql
stable
security definer
set search_path = ''
as $similar_recall_cases$
  with scored as (
    select
      c.id,
      -- 코사인 거리(0=같음)를 유사도(1=같음)로 뒤집는다. 화면이 읽기 쉬운 방향이다
      round((1 - (c.embedding OPERATOR(extensions.<=>) p_embedding))::numeric, 4) as sim,
      case
        when p_gpc_brick   is not null and c.gpc_verified_brick_code   = p_gpc_brick   then 'BRICK'
        when p_gpc_class   is not null and c.gpc_verified_class_code   = p_gpc_class   then 'CLASS'
        when p_gpc_family  is not null and c.gpc_verified_family_code  = p_gpc_family  then 'FAMILY'
        when p_gpc_segment is not null and c.gpc_verified_segment_code = p_gpc_segment then 'SEGMENT'
        else 'NONE'
      end as lvl,
      c.source_type
    from public.case_event c
    where c.source_type <> 'ACCIDENT'
      and c.embedding is not null
  )
  select s.id, s.sim, s.lvl, s.source_type
  from scored s
  where not p_require_gpc or s.lvl <> 'NONE'
  -- GPC 가 맞는 것을 먼저, 그다음 유사도. 계층 일치는 임베딩보다 믿을 만한 신호다
  order by (case when s.lvl = 'NONE' then 1 else 0 end), s.sim desc
  limit greatest(1, p_limit)
$similar_recall_cases$;

comment on function public.similar_recall_cases(extensions.vector, text, text, text, text, integer, boolean) is
  '사고 사건과 닮은 리콜 사례. case_event.embedding 을 처음으로 쓰는 자리다';

-- 새 함수는 anon/authenticated 실행 권한이 자동으로 열린다(Supabase 기본 동작).
-- 의도한 것이 아니므로 반드시 거둔다 — 실제로 이 실수가 있었고 어드바이저로 발견했다
revoke execute on function public.similar_recall_cases(extensions.vector, text, text, text, text, integer, boolean) from public;
revoke execute on function public.similar_recall_cases(extensions.vector, text, text, text, text, integer, boolean) from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 사진에서 건질 재료를 넓힐 자리 (3단계에서 채운다)
--
-- 지금 비전 프롬프트는 "손상·탄 흔적·파손·변형"만 관찰하라고 좁혀 놔서, 실제 사진의
-- 다수인 온도그래프(40~90℃)·전력분석기 화면(220.86V·8.660A)·내부 기판(전지·펌프·
-- 밸브·히터 커넥터)이 버려진다. 원인을 단정할 근거는 아니지만 시험항목을 고르는
-- 데는 바로 쓸 재료다(라운드 69).
--
-- vision_prompt_variant 를 함께 두는 이유 — 라운드 69 가 사진 단서 실험에서 대조군
-- 없이 결론 낼 뻔했다. 어느 판 프롬프트로 얻은 관찰인지 모르면 다시 잴 수 없다.
-- -----------------------------------------------------------------------------
alter table public.source_file_image
  add column if not exists measurements          jsonb  not null default '[]'::jsonb,
  add column if not exists components            text[] not null default '{}',
  add column if not exists vision_prompt_variant text;

comment on column public.source_file_image.measurements is
  '사진에서 읽은 측정값 [{label,value,unit}]. 온도그래프·전력계 화면 등 (3단계)';
comment on column public.source_file_image.components is
  '사진에서 식별한 내부 부품 구성. 인증 당시 구성과의 대조 재료 (3단계)';
