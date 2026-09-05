-- =============================================================================
-- 결과에서 원인으로 가는 다리 (04-1 문서)
--
-- 왜 필요한가
--   사고조사보고서 70건 중 54건(77%)이 원인 미상이다. 조사 자체가 원인을 특정하지
--   못한 것이라 문서에서 뽑을 수가 없다. 그래서 시스템에 남는 것은 피해유형뿐이고,
--   피해유형이 같은 조항만 찾게 된다.
--
--   담당자는 다르게 한다. 피해에서 원인을 짐작하고, 그 원인을 확인할 시험을 고른다.
--   화재가 났으면 "습기가 들어가 누전됐을 수 있다"를 떠올리고 내습성·누설전류를
--   의뢰한다. 그 중간 단계가 이 두 표다.
--
-- 근거 자료가 이미 있다
--   해외 리콜 2,299건 중 2,072건에 원인 코드가 붙어 있다(원인 미상 10%). 사고보고서와
--   달리 리콜은 원인이 밝혀진 자료다. 여기서 "어떤 피해에 어떤 원인이 따라왔는가"를
--   세면 사고보고서에 쓸 수 있다.
--
-- 코드북에 두는 이유
--   두 코드 축을 잇는 관계이므로 코드 정의 옆이 맞다. 코드끼리의 관계를 본 체계가
--   따로 들고 있으면, 코드북을 별도 서비스로 떼어 낼 때 관계만 남겨지게 된다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 원인 코드의 확인 경로 — 불량인가 불법인가
-- -----------------------------------------------------------------------------
--
-- 이 구분이 산출물을 가른다.
--   불량은 안전기준의 기능·성능에 불합격한 것이라 시험을 해야 안다.
--   불법은 법령이 정한 의무(인증·표시·부품변경 재인증)를 지키지 않은 것이라
--   법령을 보면 판정된다.
--
-- docs/제품안전법제도/★★★★업무이해 20230405.xlsx 「불법제품 단속」 시트:
--   "불법은 기준이 있어 판단이 가능하나, 리콜은 안전성조사가 선행되어야 함"
--
-- 통계만으로는 이 둘이 섞인다. 실제로 화재 사고에서 「법적 인증 고의 위반」이
-- 리프트 1.84 로 상위에 올라오는데, 불법 제조 여부를 판정하는 KC 시험 조항은 없다.
-- 시험항목 목록에 섞이면 안 되므로 여기서 경로를 갈라 둔다.
--
-- 코드북 판번호를 키에 넣지 않은 이유
--   확인 경로는 코드의 뜻이 바뀌지 않는 한 그대로다. 판마다 64줄을 복제하면
--   고칠 때 어느 판을 고쳐야 하는지가 새 문제가 된다.
create table if not exists codebook.hf_route (
  code       varchar(30) primary key,
  route      text not null check (route in ('TEST', 'LEGAL', 'GAP', 'OTHER')),
  note       text,
  updated_at timestamptz not null default now()
);

comment on table  codebook.hf_route      is '원인 코드를 무엇으로 확인하는가. TEST 만 시험항목 도출 대상이다(04-1 §4)';
comment on column codebook.hf_route.route is
  'TEST 불량(안전기준 시험) / LEGAL 불법(법령 위반) / GAP 기준 자체가 미흡 / OTHER 관리·공정·사람 요인';

-- -----------------------------------------------------------------------------
-- 피해유형 → 원인 후보
-- -----------------------------------------------------------------------------
--
-- 뷰가 아니라 표인 이유
--   리콜은 계속 쌓이므로 같은 질의라도 시점마다 답이 달라진다. 나중에 "그때 왜 이
--   후보를 냈는가"를 되짚으려면 그 시점의 값이 남아 있어야 한다. computed_at 과
--   sample_size 가 그 근거다.
--
-- 확인 경로로 걸러서 담지 않는다
--   LEGAL·GAP 도 그대로 담는다. 걸러 내면 "이 제품군은 시험보다 인증·표시를 먼저
--   봐야 한다"는 다른 산출물을 만들 수 없다. 거르기는 쓸 때 한다.
create table if not exists codebook.cause_bridge (
  dt_code     varchar(30) not null,
  hf_code     varchar(30) not null,
  -- 어느 자료를 세어 얻었나. 국내 리콜이 들어오면 같은 이름으로 함께 계산된다
  source      text        not null,
  -- 함께 나온 사건 수. 근거의 두께다
  support     integer     not null check (support > 0),
  -- P(원인 | 피해). 이 피해일 때 이 원인이 나온 비율
  confidence  numeric     not null,
  -- 특이성. 이 피해일 때의 비율 ÷ 평소 비율.
  -- 1 근처면 그 피해와 무관하게 원래 흔한 원인이라 후보로서 값어치가 없다.
  -- 실측: 설계결함은 화재와 116건 함께 나오지만 어느 사고에나 붙어 리프트 0.96 이다.
  lift        numeric     not null,
  -- 이 피해유형을 가진 사건 수 (confidence 의 분모)
  sample_size integer     not null,
  computed_at timestamptz not null default now(),
  primary key (dt_code, hf_code, source)
);

comment on table  codebook.cause_bridge is
  '피해유형에서 원인 후보로 건너가는 다리. 리콜 자료의 동시출현을 세어 만든다(04-1)';
comment on column codebook.cause_bridge.lift is
  '특이성. 이 피해일 때의 비율 / 평소 비율. 빈도가 아니라 이 값으로 순위를 매긴다';
comment on column codebook.cause_bridge.sample_size is
  '이 피해유형을 가진 사건 수. 근거의 두께를 화면에 표시할 때 분모로 쓴다';

create index if not exists cause_bridge_lookup_idx
  on codebook.cause_bridge (dt_code, lift desc);

-- -----------------------------------------------------------------------------
-- 확인 경로 초기값 — 코드 규칙으로 채운다
-- -----------------------------------------------------------------------------
--
-- 64개를 손으로 적지 않고 코드 계통으로 채운다. 코드 체계가 이미 성격을 담고 있다.
--   H 하드웨어 · E 환경   제품에서 재현·측정할 수 있으므로 시험 대상이다
--   M.DES 설계결함        설계가 원인이면 그 결과가 성능시험에서 드러난다
--   M.REG 인증 위반       법령 위반이다
--   S.INFO 안전정보 부족  표시사항 의무 위반이다. 안전기준 문서 안에 있어도 불법으로 본다
--   S.NATL/INTL 표준 미흡 기준 자체의 공백이라 3번째 산출물(사각지대)의 자료다
--   그 밖(관리·공정·사람) 시험으로 확인할 수 없다
--
-- OTHER 를 더 쪼개지 않은 이유: 코드북에 M-SHELL 대분류가 이미 있어 필요할 때
-- 그것으로 나눌 수 있다. 같은 정보를 두 칸에 두지 않는다.
--
-- 규칙이 틀린 줄은 나중에 이 표를 직접 고쳐 바로잡는다. 초기값이 얼마나 맞는지
-- 세어 보기 전에는 검수 화면을 만들지 않는다.
insert into codebook.hf_route (code, route, note)
select
  hf.code,
  case
    when hf.code like 'HF.H%' or hf.code like 'HF.E%'         then 'TEST'
    when hf.code = 'HF.M.DES'                                  then 'TEST'
    when hf.code like 'HF.M.REG%'                              then 'LEGAL'
    when hf.code like 'HF.S.INFO%'                             then 'LEGAL'
    when hf.code like 'HF.S.NATL%' or hf.code like 'HF.S.INTL%' then 'GAP'
    else 'OTHER'
  end,
  '003 초기값 — 코드 계통 규칙으로 채움'
from codebook.hazard_factor hf
join codebook.version v on v.id = hf.version_id and v.status = 'active'
on conflict (code) do nothing;
