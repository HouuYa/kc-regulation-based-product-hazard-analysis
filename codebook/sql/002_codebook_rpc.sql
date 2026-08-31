-- =============================================================================
-- 코드북 조회 함수 (설계문서 §2.4.3)
--
-- 왜 public 스키마에 두는가
--   PostgREST 는 노출 스키마의 함수만 RPC 로 공개한다. public 에 두면 대시보드
--   설정 없이 바로 호출되고, 나중에 코드북을 별도 Project 로 옮겨도 그쪽 public 에
--   같은 이름으로 존재하게 되므로 이용 시스템(본 체계·Recall Hub)의 호출부가
--   한 줄도 바뀌지 않는다. 설계문서가 노린 "정의는 한 곳, 호출은 어디서나" 다.
--
-- 왜 전부 버전을 입력받는가 (§2.4.3)
--   버전 없이 "지금 코드 목록"만 주면 과거 태깅이 어떤 정의로 붙었는지 되짚을 수 없다.
--   p_version 을 생략하면 현재 유효 버전을 쓰되, 무엇을 썼는지 항상 함께 돌려준다.
--
-- security definer + search_path = '' 인 이유
--   기반 표는 RLS 로 잠겨 있다(001). 이용 시스템은 이 함수로만 읽는다 —
--   §2.4.3 "접근 권한은 조회 전용 키로 분리, 이용 시스템이 코드북을 고칠 수 없게 함".
--   search_path 를 비우면 검색 경로 조작으로 다른 객체를 끼워 넣는 공격을 막을 수 있어
--   모든 객체를 스키마까지 적어 준다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 현재 유효 버전 — 캐시 갱신이 필요한지 판단할 때 쓴다
-- -----------------------------------------------------------------------------
create or replace function public.get_current_version()
returns table (version_id bigint, version text, effective_date date)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.version, v.effective_date
  from codebook.version v
  where v.status = 'active';
$$;

comment on function public.get_current_version() is
  '현재 유효한 코드북 버전. 이용 시스템은 이 값으로 로컬 스냅샷 갱신 여부를 판단한다(2.4.2)';

-- -----------------------------------------------------------------------------
-- 내부 헬퍼 — 버전 문자열을 id 로 바꾼다. null 이면 현재 유효 버전.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_version_id(p_version text default null)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select v.id
  from codebook.version v
  where (p_version is null and v.status = 'active')
     or (p_version is not null and v.version = p_version)
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- 코드 전체 목록
--
-- 쓰임 두 가지 (§2.4.3)
--   1) 태깅 프롬프트의 enum 생성 — 코드 목록을 못박아 없는 코드 창작을 원천 차단(5.2.2)
--   2) 이용 시스템의 로컬 스냅샷 적재 — 배치가 건별 원격 조회를 하면 느리고 불안정하다
--
-- p_axis: 'HF' | 'DT' | null(둘 다)
-- p_include_uncommon: false 면 L0·L1 을 제외한다.
--   담당자가 실수로 L0·L1 만 단독 입력하는 오류를 막기 위함(PDR §0.4 정책).
-- -----------------------------------------------------------------------------
create or replace function public.get_codes(
  p_version           text default null,
  p_axis              text default null,
  p_include_uncommon  boolean default true
)
returns table (
  version          text,
  axis             text,
  code             varchar(30),
  name_ko          text,
  name_en          text,
  definition       text,
  parent_code      varchar(30),
  depth            smallint,
  is_recall_common boolean,
  extra            jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with v as (
    select ver.id, ver.version
    from codebook.version ver
    where ver.id = public.resolve_version_id(p_version)
  )
  select
    v.version,
    'HF'::text,
    hf.code,
    hf.name_ko,
    hf.name_en,
    hf.definition,
    hf.parent_code,
    hf.depth,
    hf.is_recall_common,
    jsonb_build_object(
      'mshell_level1', hf.mshell_level1,
      'category_l2',   hf.category_l2,
      'category_l3',   hf.category_l3,
      'mshell_link',   hf.mshell_link,
      'example',       hf.example,
      'source_section', hf.source_section
    )
  from codebook.hazard_factor hf
  cross join v
  where hf.version_id = v.id
    and hf.is_active
    and (p_axis is null or p_axis = 'HF')
    and (p_include_uncommon or hf.is_recall_common)

  union all

  select
    v.version,
    'DT'::text,
    dt.code,
    dt.name_ko,
    dt.name_en,
    dt.definition,
    ('DT.' || dt.dt_group)::varchar(30),
    3::smallint,
    true,
    jsonb_build_object(
      'dt_group',           dt.dt_group,
      'severity_min',       dt.severity_min,
      'severity_max',       dt.severity_max,
      'prism_risk_level',   dt.prism_risk_level,
      'eu_safetygate_type', dt.eu_safetygate_type,
      'source_section',     dt.source_section
    )
  from codebook.damage_type dt
  cross join v
  where dt.version_id = v.id
    and dt.is_active
    and (p_axis is null or p_axis = 'DT')

  order by 2, 3;
$$;

comment on function public.get_codes(text, text, boolean) is
  '코드 전체 목록. 태깅 프롬프트의 enum 생성과 로컬 스냅샷 적재에 쓴다(2.4.3)';

-- -----------------------------------------------------------------------------
-- 코드 1건 상세 — 화면 툴팁·검수 화면용 (§2.4.3)
-- 정의·예시·상위코드에 더해 키워드와 적용되는 제약까지 한 번에 준다.
-- -----------------------------------------------------------------------------
create or replace function public.get_code_detail(
  p_code    text,
  p_version text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with v as (
    select ver.id, ver.version
    from codebook.version ver
    where ver.id = public.resolve_version_id(p_version)
  ),
  base as (
    select to_jsonb(hf) - 'version_id' as row_json, 'HF' as axis
    from codebook.hazard_factor hf, v
    where hf.version_id = v.id and hf.code = p_code
    union all
    select to_jsonb(dt) - 'version_id', 'DT'
    from codebook.damage_type dt, v
    where dt.version_id = v.id and dt.code = p_code
  )
  select jsonb_build_object(
    'version', (select version from v),
    'axis',    (select axis from base),
    'code',    p_code,
    'detail',  (select row_json from base),
    'keywords', coalesce(
      (select jsonb_agg(k.keyword order by k.keyword)
       from codebook.code_keyword k, v
       where k.version_id = v.id and k.code = p_code),
      '[]'::jsonb
    ),
    'constraints', coalesce(
      (select jsonb_agg(jsonb_build_object(
                'rule_type',       c.rule_type,
                'requires_any_of', c.requires_any_of,
                'reason',          c.reason,
                'source_section',  c.source_section))
       from codebook.code_constraint c, v
       where c.version_id = v.id and p_code like c.subject_prefix || '%'),
      '[]'::jsonb
    )
  )
  where exists (select 1 from base);
$$;

comment on function public.get_code_detail(text, text) is
  '코드 1건의 정의·예시·상위코드·키워드·제약. 화면 툴팁과 검수 화면에 쓴다(2.4.3)';

-- -----------------------------------------------------------------------------
-- 코드 유효성 판정 + 폐지 코드 자동 치환 (§2.4.3)
--
-- 태깅 저장 직전에 반드시 통과시킨다. Structured Outputs 의 enum 을 통과했더라도
-- 코드북에 없는 조합이면 여기서 거부한다 — "스키마를 통과해도 한 번 더 검증"(5.2.2)
-- -----------------------------------------------------------------------------
create or replace function public.resolve_code(
  p_code    text,
  p_version text default null
)
returns table (is_valid boolean, resolved_code varchar(30), reason text)
language sql
stable
security definer
set search_path = ''
as $$
  with v as (
    select ver.id from codebook.version ver
    where ver.id = public.resolve_version_id(p_version)
  ),
  hit as (
    select hf.code, hf.is_active, hf.replaced_by from codebook.hazard_factor hf, v
    where hf.version_id = v.id and hf.code = p_code
    union all
    select dt.code, dt.is_active, dt.replaced_by from codebook.damage_type dt, v
    where dt.version_id = v.id and dt.code = p_code
  )
  select
    case
      when not exists (select 1 from hit) then false
      when (select is_active from hit)     then true
      when (select replaced_by from hit) is not null then true
      else false
    end,
    case
      when not exists (select 1 from hit) then null::varchar(30)
      when (select is_active from hit) then (select code from hit)
      else (select replaced_by from hit)::varchar(30)
    end,
    case
      when not exists (select 1 from hit) then '코드북에 없는 코드'
      when (select is_active from hit) then '유효'
      when (select replaced_by from hit) is not null then '폐지 코드 — 대체 코드로 치환'
      else '폐지 코드 — 대체 코드 없음'
    end;
$$;

comment on function public.resolve_code(text, text) is
  '저장 전 코드 검증과 폐지 코드 자동 치환. LLM 이 없는 코드를 지어냈는지 여기서 걸러진다(5.2.2)';

-- -----------------------------------------------------------------------------
-- 코드 조합 검증 — L0·L1 단독 사용 금지 규칙 (PDR §0.4·§4.4)
--
-- 규칙을 애플리케이션에 박지 않고 codebook.code_constraint 표를 읽어 판정한다.
-- 코드북이 개정되어 제약이 바뀌어도 이 함수는 고칠 필요가 없다.
-- -----------------------------------------------------------------------------
create or replace function public.validate_code_set(
  p_hf_codes text[],
  p_dt_codes text[] default '{}',
  p_version  text default null
)
returns table (severity text, subject varchar(30), message text)
language sql
stable
security definer
set search_path = ''
as $$
  with v as (
    select ver.id from codebook.version ver
    where ver.id = public.resolve_version_id(p_version)
  ),
  -- 존재하지 않는 코드
  unknown_codes as (
    select 'ERROR'::text as severity, c::varchar(30) as subject,
           '코드북에 없는 코드'::text as message
    from unnest(coalesce(p_hf_codes, '{}') || coalesce(p_dt_codes, '{}')) c
    where not exists (
      select 1 from codebook.hazard_factor hf, v
      where hf.version_id = v.id and hf.code = c
      union all
      select 1 from codebook.damage_type dt, v
      where dt.version_id = v.id and dt.code = c
    )
  ),
  -- 병기 제약 위반
  violations as (
    select
      case when con.rule_type = 'REQUIRES_ANY_OF' then 'ERROR' else 'WARN' end::text,
      c::varchar(30),
      (con.reason || ' — 다음 중 하나를 함께 기록해야 합니다: '
        || array_to_string(con.requires_any_of, ', ')
        || ' (' || con.source_section || ')')::text
    from unnest(coalesce(p_hf_codes, '{}')) c
    join v on true
    join codebook.code_constraint con
      on con.version_id = v.id
     and c like con.subject_prefix || '%'
    where not exists (
      select 1 from unnest(coalesce(p_hf_codes, '{}')) other
      where other = any (con.requires_any_of)
    )
  )
  select * from unknown_codes
  union all
  select * from violations;
$$;

comment on function public.validate_code_set(text[], text[], text) is
  'HF·DT 코드 묶음의 조합 검증. L0·L1 단독 사용 금지(PDR 0.4)를 데이터로 판정한다';

-- -----------------------------------------------------------------------------
-- 버전 간 차이 — 재태깅 대상 산정과 화면 B 의 신규·변경·삭제 표시 (§2.4.3, §8.2)
-- -----------------------------------------------------------------------------
create or replace function public.diff_versions(p_v1 text, p_v2 text)
returns table (
  change_type text,
  axis        text,
  code        varchar(30),
  name_before text,
  name_after  text
)
language sql
stable
security definer
set search_path = ''
as $$
  with a as (
    select 'HF' axis, hf.code, hf.name_ko, hf.definition
    from codebook.hazard_factor hf
    join codebook.version v on v.id = hf.version_id and v.version = p_v1
    union all
    select 'DT', dt.code, dt.name_ko, dt.definition
    from codebook.damage_type dt
    join codebook.version v on v.id = dt.version_id and v.version = p_v1
  ),
  b as (
    select 'HF' axis, hf.code, hf.name_ko, hf.definition
    from codebook.hazard_factor hf
    join codebook.version v on v.id = hf.version_id and v.version = p_v2
    union all
    select 'DT', dt.code, dt.name_ko, dt.definition
    from codebook.damage_type dt
    join codebook.version v on v.id = dt.version_id and v.version = p_v2
  )
  select
    case
      when a.code is null then 'ADDED'
      when b.code is null then 'REMOVED'
      else 'CHANGED'
    end,
    coalesce(a.axis, b.axis),
    coalesce(a.code, b.code),
    a.name_ko,
    b.name_ko
  from a
  full outer join b on a.axis = b.axis and a.code = b.code
  where a.code is null
     or b.code is null
     or a.name_ko is distinct from b.name_ko
     or a.definition is distinct from b.definition
  order by 2, 3;
$$;

comment on function public.diff_versions(text, text) is
  '두 버전의 신규·변경·삭제 코드. 재태깅 대상 규모를 미리 확인한다(8.2)';

-- -----------------------------------------------------------------------------
-- 조회 전용 공개
--
-- 함수는 읽기만 하고(stable, select 전용) 기반 표는 RLS 로 잠겨 있으므로,
-- 이용 시스템은 코드북을 고칠 수 없다(§2.4.3).
-- 코드 등록·수정은 화면 B 에서 서버 권한으로만 한다.
--
-- PUBLIC 부터 회수하는 이유
--   Postgres 는 새 함수에 EXECUTE 를 PUBLIC 에 자동으로 준다. anon·authenticated 는
--   PUBLIC 을 상속하므로, 회수하지 않으면 "누구에게 열어 줄지" 를 우리가 정하는 게
--   아니라 기본값이 정하게 된다. 먼저 전부 닫고, 열 대상을 하나씩 적는다.
--
-- 코드북을 anon 에 여는 것은 의도된 설계다.
--   코드북은 여러 시스템이 참조해야 하는 공표된 분류 체계이고(§2.4.2),
--   민감정보가 없으며, 이 함수들은 읽기 전용이다.
-- -----------------------------------------------------------------------------
revoke execute on function
  public.get_current_version(),
  public.get_codes(text, text, boolean),
  public.get_code_detail(text, text),
  public.resolve_code(text, text),
  public.validate_code_set(text[], text[], text),
  public.diff_versions(text, text),
  public.resolve_version_id(text)
from public;

grant execute on function
  public.get_current_version(),
  public.get_codes(text, text, boolean),
  public.get_code_detail(text, text),
  public.resolve_code(text, text),
  public.validate_code_set(text[], text[], text),
  public.diff_versions(text, text)
to anon, authenticated, service_role;

-- 내부 헬퍼는 서버만 쓴다. 버전 해석을 밖에서 직접 호출할 이유가 없다
grant execute on function public.resolve_version_id(text) to service_role;
