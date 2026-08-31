-- =============================================================================
-- 리콜 캐시 — Recall Hub 에서 조회해 실제 분석에 쓴 건만 보관
--
-- 근거: 설계문서 §0.2 방안 A "API 조회 + 결과 캐시"
--   Supabase 는 Project 가 다르면 물리적으로 다른 PostgreSQL 인스턴스이므로
--   본 체계의 조항 테이블과 Recall Hub 의 리콜 테이블을 한 번에 조인할 수 없다.
--   지금 필요한 것은 건별 대조이고 통계는 데이터가 쌓인 뒤의 일이므로,
--   전체 복제(방안 B)의 관리 부담을 지지 않는다.
--
--   "옆 부서 서류를 매번 복사해 오면 어느 쪽이 최신인지 모르게 된다.
--    필요한 건만 빌려 보고, 실제로 인용한 것만 사본으로 철해 둔다."
--
-- 실물 확인 결과 (Recall Hub API 규격)
--   GET /api/v1/recalls | /search | /recent | /{source}/{guid} | /stats
--   인증: Authorization: Bearer rh_live_*  또는  X-API-Key: rh_live_*
--   외부 API 키로는 승인(approved) 건만 조회된다 — 설계문서 0.2 의 "승인된 것만" 과 일치
--   recalls 표에 hazard_factor_code / damage_type_codes 가 이미 있다(해외 리콜 태깅 완료)
-- =============================================================================

create table if not exists public.recall_cache (
  id                bigint generated always as identity primary key,

  -- Recall Hub 의 자연키
  source            text not null,
  guid              text not null,

  origin            text not null default 'OVERSEAS'
                      check (origin in ('OVERSEAS', 'DOMESTIC')),

  title             text,
  brand             text,
  model             text,
  product_category  text,
  hazard_summary    text,
  published_on      date,
  detail_url        text,

  -- Recall Hub 가 이미 붙여 둔 코드. 국내 리콜은 우리가 태깅해야 한다(§3.1)
  hazard_factor_code   varchar(30),
  hazard_factor_sub    text[] not null default '{}',
  damage_type_primary  varchar(30),
  damage_type_codes    text[] not null default '{}',

  -- 원본 응답 전체. 필드가 늘어도 다시 받아 올 필요가 없다(§7.1 원본층)
  raw               jsonb not null default '{}'::jsonb,

  -- 언제 인용해 왔는가. 원본은 협회가 관리하므로 신선도를 알아야 한다
  fetched_at        timestamptz not null default now(),
  -- 이 캐시로 만들어진 사건 행 (있으면)
  case_id           bigint references public.case_event(id) on delete set null,

  unique (source, guid)
);

comment on table  public.recall_cache        is 'Recall Hub 에서 조회해 실제 분석에 사용한 리콜만 보관. 원본은 협회가 관리한다(0.2 방안 A)';
comment on column public.recall_cache.origin is 'OVERSEAS=Recall Hub 태깅 완료 / DOMESTIC=국내리콜, 우리가 태깅해야 함(3.1)';
comment on column public.recall_cache.raw    is 'API 응답 원본. 파생 컬럼을 늘려도 다시 받아 올 필요가 없다';
comment on column public.recall_cache.fetched_at is '인용 시각. 원본이 갱신됐는지 판단하는 기준';

create index if not exists recall_cache_origin_idx   on public.recall_cache (origin, published_on desc);
create index if not exists recall_cache_hf_idx       on public.recall_cache (hazard_factor_code);
create index if not exists recall_cache_dt_gin_idx   on public.recall_cache using gin (damage_type_codes);
create index if not exists recall_cache_case_idx     on public.recall_cache (case_id);

alter table public.recall_cache enable row level security;
