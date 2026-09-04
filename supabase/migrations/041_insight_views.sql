-- =============================================================================
-- 3번째 산출물 — KC안전기준 개선 요인 (안 1: 읽기 전용 집계)
--
-- 무엇을 만드는가 (컨셉 v0.4 세 번째 산출물, 02 설계서 7장)
--   1) 기준 사각지대       사고·리콜은 있는데 대응할 조항이 없는 자리
--   2) 국내외 기준 차이     해외가 근거로 든 표준과 국내 기준의 대조 상태
--   3) 저활용 시험항목      후보로는 나오는데 채택되지 않는 시험방법
--
-- 왜 뷰인가 (안 1)
--   원 계획서는 안 1(읽기 전용) → 안 2(스냅샷) → 안 3(개선 후보 등록) 순서를
--   권했다. 지금은 집계 정의가 실제 데이터에서 성립하는지부터 봐야 하는 단계다.
--   표를 먼저 만들면 정의가 틀렸을 때 그 표까지 같이 버려야 한다.
--
-- 이 집계가 절대 하면 안 되는 것
--   "기준이 낮다·높다", "강화해야 한다", "법적 의무가 있다"를 말하지 않는다.
--   숫자와 그 숫자가 어디서 왔는지만 보여 준다. 판단은 담당 부서와 전문가가 한다.
--
-- 0 건의 뜻을 나누는 것이 이 집계의 핵심이다 (v0.7 §7.8)
--   "대응 조항이 없다"와 "아직 분석을 안 했다"와 "코드가 없다"는 전혀 다른 말인데,
--   전부 0 으로 보인다. 그것을 섞으면 자료 누락이 정책 신호로 둔갑한다.
--   그래서 모든 뷰가 상태(status) 칸을 갖고, 화면은 상태별로 나눠 보여 준다.
--
-- 지금 이 표들은 대부분 비어 있을 것이다
--   실측(2026-09-04): 분석 실행 12건, 후보 220건, 담당자 검토 기록 0건,
--   조항 태그 검수 0건. 채택·반려가 하나도 없으므로 "후보는 있으나 모두 반려"
--   같은 칸은 0 이 나온다.
--
--   그것이 잘못된 것이 아니라 지금의 사실이다. 표가 비어 있는 것 자체가
--   "아직 판단이 쌓이지 않았다"는 정보다. 숫자를 만들어 내지 않는다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 기준 사각지대
--
-- 사건을 품목·HF·DT 로 묶고, 그 묶음이 어디까지 갔는지 본다.
--
-- 상태를 나누는 순서가 중요하다. 앞의 것이 참이면 뒤는 보지 않는다 —
-- 품목이 없으면 분석 자체가 불가능하므로 "대응 조항 없음"이라고 말할 자격이 없다.
-- -----------------------------------------------------------------------------
create or replace view public.insight_standard_gap
with (security_invoker = true) as
with base as (
  select
    e.id                                   as case_id,
    e.source_type,
    e.product_scope_id,
    coalesce(ps.name, '(품목 미확정)')      as scope_name,
    coalesce(
      (select t.code from public.case_tag t
       where t.case_id = e.id and t.axis = 'HF' and t.review_status <> 'rejected'
       order by t.is_primary desc, t.code limit 1),
      '(코드 없음)')                        as hf_code,
    coalesce(
      (select t.code from public.case_tag t
       where t.case_id = e.id and t.axis = 'DT' and t.review_status <> 'rejected'
       order by t.is_primary desc, t.code limit 1),
      '(코드 없음)')                        as dt_code,
    -- 이 사건의 마지막 분석 실행
    (select r.id from public.match_run r
      where r.case_id = e.id order by r.started_at desc limit 1) as last_run_id
  from public.case_event e
  left join public.product_scope ps on ps.id = e.product_scope_id
),
per_case as (
  select
    b.*,
    (b.last_run_id is not null)                                        as analyzed,
    coalesce((select r.result_count from public.match_run r
              where r.id = b.last_run_id), 0)                          as candidates,
    coalesce((select count(*)::int from public.review_log rl
              join public.match_result mr on mr.id = rl.match_result_id
              where mr.run_id = b.last_run_id and rl.decision = 'ADOPTED'), 0) as adopted,
    coalesce((select count(*)::int from public.review_log rl
              join public.match_result mr on mr.id = rl.match_result_id
              where mr.run_id = b.last_run_id and rl.decision = 'REJECTED'), 0) as rejected,
    coalesce((select count(*)::int from public.review_log rl
              join public.match_result mr on mr.id = rl.match_result_id
              where mr.run_id = b.last_run_id), 0)                     as reviewed
  from base b
)
select
  source_type,
  scope_name,
  hf_code,
  dt_code,
  count(*)::int                                          as case_count,
  count(*) filter (where analyzed)::int                  as analyzed_count,
  sum(candidates)::int                                   as candidate_total,
  sum(adopted)::int                                      as adopted_total,
  sum(rejected)::int                                     as rejected_total,
  /*
    상태 — 앞에서 걸리면 뒤는 보지 않는다

    SCOPE_UNRESOLVED  품목이 없다. 적용할 기준을 정할 수 없으므로 사각지대라고
                      말할 수 없다. 자료를 갖추는 일이다
    NOT_CODED         HF/DT 가 없다. 코드로 맞춰 볼 수가 없다
    NOT_ANALYZED      아직 분석을 돌리지 않았다
    NO_CANDIDATE      분석했는데 후보가 0건이다 → 사각지대 후보
    NOT_REVIEWED      후보는 나왔는데 담당자가 아직 안 봤다. 판단이 없으므로
                      사각지대인지 오탐인지 말할 수 없다
    ALL_REJECTED      후보를 담당자가 모두 반려했다 → 사각지대 후보(더 강한 신호)
    COVERED           채택된 조항이 있다. 사각지대가 아니다
  */
  case
    when bool_and(product_scope_id is null)         then 'SCOPE_UNRESOLVED'
    when hf_code = '(코드 없음)' or dt_code = '(코드 없음)' then 'NOT_CODED'
    when count(*) filter (where analyzed) = 0       then 'NOT_ANALYZED'
    when sum(candidates) = 0                        then 'NO_CANDIDATE'
    when sum(reviewed) = 0                          then 'NOT_REVIEWED'
    when sum(adopted) = 0                           then 'ALL_REJECTED'
    else 'COVERED'
  end as status
from per_case
group by source_type, scope_name, hf_code, dt_code, product_scope_id
order by case_count desc, scope_name, hf_code;

comment on view public.insight_standard_gap is
  '기준 사각지대 후보. 0건의 뜻을 상태로 나눈다 — 자료 누락을 정책 신호로 오인하지 않기 위해서다';

-- -----------------------------------------------------------------------------
-- 2) 국내외 기준 수준 차이
--
-- 해외 리콜이 근거로 든 표준과 국내 기준이 대조되는지를 본다.
-- **수준의 높낮이는 판정하지 않는다.** 번호가 이어지는지, 이어졌다면 국내 조항에
-- 비교할 수치(허용치·시험조건)가 구조화돼 있는지까지만 말한다.
--
-- 컨셉 8장 7번이 못박아 둔 전제 때문이다 — 상대국이 어떤 기준을 근거로 조치했는지
-- 알아야 비교가 된다. 문장만 보고 높낮이를 추정하면 근거 없는 결론이 된다.
-- -----------------------------------------------------------------------------
create or replace view public.insight_standard_comparison
with (security_invoker = true) as
with cited as (
  select
    rc.id            as recall_cache_id,
    rc.case_id,
    rc.source,
    rc.recall_country,
    unnest(rc.cited_standards) as cited_standard,
    rc.matched_standard_ids
  from public.recall_cache rc
  where cardinality(rc.cited_standards) > 0
)
select
  c.cited_standard,
  c.recall_country,
  count(distinct c.recall_cache_id)::int as recall_count,
  count(distinct s.id)::int              as matched_standard_count,
  -- 대조된 국내 기준 이름. 없으면 비어 있다
  (array_agg(distinct s.display_name) filter (where s.id is not null))::text[] as matched_standards,
  -- 대조된 국내 기준에 비교할 수치가 있는가
  coalesce(sum(
    (select count(*)::int from public.test_condition tc
     join public.clause cl on cl.id = tc.clause_id
     where cl.standard_id = s.id)
  ), 0)::int as domestic_test_conditions,
  /*
    상태

    COMPARABLE       번호가 이어지고, 국내 조항에 구조화된 수치가 있다 → 비교 후보
    MATCHED_NO_DATA  번호는 이어지는데 비교할 수치가 없다. 사람이 원문을 봐야 한다
    NUMBER_MISMATCH  번호 체계가 달라 이어지지 않는다(EN 71·GB 4706 계열).
                     "국내에 기준이 없다"는 뜻이 아니다 — 번호로 못 잇는다는 뜻이다
  */
  case
    when count(distinct s.id) = 0 then 'NUMBER_MISMATCH'
    when coalesce(sum(
      (select count(*)::int from public.test_condition tc
       join public.clause cl on cl.id = tc.clause_id
       where cl.standard_id = s.id)), 0) = 0 then 'MATCHED_NO_DATA'
    else 'COMPARABLE'
  end as status
from cited c
left join public.standard s
  on s.id = any (c.matched_standard_ids) and s.is_current
group by c.cited_standard, c.recall_country
order by recall_count desc, c.cited_standard;

comment on view public.insight_standard_comparison is
  '해외 근거 표준과 국내 기준의 대조 상태. 수준의 높낮이는 판정하지 않는다 — 대조 가능 여부까지만 말한다';

-- -----------------------------------------------------------------------------
-- 3) 저활용 시험항목
--
-- 시험방법 조항이 후보로 얼마나 나왔고 얼마나 채택됐는지 본다.
--
-- "채택이 적다"와 "사고·리콜이 없다"를 같은 뜻으로 보지 않는다. 후보로 제시된
-- 적이 아예 없는 것과, 제시됐는데 담당자가 안 골랐던 것은 뜻이 전혀 다르다.
-- -----------------------------------------------------------------------------
create or replace view public.insight_test_usage
with (security_invoker = true) as
with test_methods as (
  -- 시험방법으로 지목되는 조항들. 같은 조항을 여러 요건이 가리킬 수 있다
  select distinct
    l.to_clause_id as clause_id,
    tm.marker,
    s.display_name as standard_name
  from public.clause_link l
  join public.clause tm  on tm.id = l.to_clause_id
  join public.standard s on s.id = tm.standard_id
  where l.link_type = 'TEST_METHOD' and l.to_clause_id is not null and s.is_current
)
select
  t.clause_id,
  t.marker,
  t.standard_name,
  -- 이 시험방법을 가리키는 성능요건 조항 수
  (select count(*)::int from public.clause_link l
    where l.to_clause_id = t.clause_id and l.link_type = 'TEST_METHOD') as requirement_count,
  -- 그 성능요건들이 후보로 제시된 횟수
  (select count(*)::int from public.match_result mr
    where mr.clause_id in (
      select l.from_clause_id from public.clause_link l
      where l.to_clause_id = t.clause_id and l.link_type = 'TEST_METHOD'))   as proposed_count,
  (select count(*)::int from public.review_log rl
    join public.match_result mr on mr.id = rl.match_result_id
    where rl.decision = 'ADOPTED' and mr.clause_id in (
      select l.from_clause_id from public.clause_link l
      where l.to_clause_id = t.clause_id and l.link_type = 'TEST_METHOD'))   as adopted_count,
  (select count(*)::int from public.review_log rl
    join public.match_result mr on mr.id = rl.match_result_id
    where rl.decision = 'REJECTED' and mr.clause_id in (
      select l.from_clause_id from public.clause_link l
      where l.to_clause_id = t.clause_id and l.link_type = 'TEST_METHOD'))   as rejected_count,
  /*
    상태

    NEVER_PROPOSED  후보로 나온 적이 없다. 관련 사고·리콜이 없었을 수도 있고,
                    분석을 아직 적게 돌렸을 수도 있다 — 지금은 구별할 수 없다
    NOT_REVIEWED    후보로는 나왔는데 담당자가 판단한 적이 없다
    LOW_ADOPTION    제시됐는데 채택된 적이 없다 → 다시 볼 후보
    IN_USE          채택된 적이 있다
  */
  case
    when (select count(*) from public.match_result mr
          where mr.clause_id in (select l.from_clause_id from public.clause_link l
            where l.to_clause_id = t.clause_id and l.link_type = 'TEST_METHOD')) = 0
      then 'NEVER_PROPOSED'
    when (select count(*) from public.review_log rl
          join public.match_result mr on mr.id = rl.match_result_id
          where mr.clause_id in (select l.from_clause_id from public.clause_link l
            where l.to_clause_id = t.clause_id and l.link_type = 'TEST_METHOD')) = 0
      then 'NOT_REVIEWED'
    when (select count(*) from public.review_log rl
          join public.match_result mr on mr.id = rl.match_result_id
          where rl.decision = 'ADOPTED' and mr.clause_id in (
            select l.from_clause_id from public.clause_link l
            where l.to_clause_id = t.clause_id and l.link_type = 'TEST_METHOD')) = 0
      then 'LOW_ADOPTION'
    else 'IN_USE'
  end as status
from test_methods t
order by t.standard_name, t.marker;

comment on view public.insight_test_usage is
  '시험방법별 제시·채택 현황. "채택이 적다"와 "사고가 없다"를 구별한다';

-- -----------------------------------------------------------------------------
-- 접근 통제 — 서버만 읽는다 (§1.3.3)
-- -----------------------------------------------------------------------------
revoke all on public.insight_standard_gap        from anon, authenticated;
revoke all on public.insight_standard_comparison from anon, authenticated;
revoke all on public.insight_test_usage          from anon, authenticated;
