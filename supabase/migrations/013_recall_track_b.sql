-- =============================================================================
-- 트랙 B — 리콜제품 분석에 필요한 열
--
-- 008 을 쓸 때 세운 전제 하나가 실물과 달랐다. 그때 주석에 이렇게 적었다.
--   "recalls 표에 hazard_factor_code / damage_type_codes 가 이미 있다(해외 리콜 태깅 완료)"
-- 실제 /api/v1/recalls 응답에는 그 두 필드가 없다. 대신 hazard_type 이라는
-- 자유 서술이 온다 — "질식 위험", "화학적 위험", "전기적 위해 (Electrical Hazard)",
-- "질식, 삼킴" 처럼 표기가 제각각이라 통제어휘로 쓸 수 없다.
--
--   확인 시각 2026-09-01, 전체 2,239건 / 출처 12곳
--
-- 그래서 해외 리콜도 조항·사고와 똑같이 우리가 HF/DT 를 붙인다. 셋이 같은 코드
-- 공간에 있어야 대조가 되기 때문이고, 그것이 이 체계의 존재 이유다.
-- 컬럼은 그대로 두되 의미를 바꾼다 — 남이 채워 주는 칸이 아니라 우리가 채우는 칸이다.
--
-- 아울러 컨셉 8장 7번이 "확보 가능한 범위를 먼저 확인해야 한다"고 남겨 둔 항목,
-- 곧 리콜 공고에 위반 표준이 명시되는 비율을 실측했다(2,239건 전수).
--
--   출처       건수   표준명시   비율
--   EU          864      450     52%     EN 71-1, EN 62115, EN 60598-2-12 …
--   CN          172      106     62%     GB 4706, GB 6675, GB 811-2022 …
--   EN(영국)     266       57     21%     BS 1363, EN 13138-3 …
--   FR          171        9      5%
--   그 밖(US_CPSC·AU·CA·JP·NZ 등)         0~1%
--   ─────────────────────────────────
--   합계      2,239      625   27.9%
--
-- 넷째 질문(국가 간 기준 수준 차이)은 이 27.9% 위에서만 성립한다. 나머지 72%는
-- 사유만 서술돼 있어 상대국 근거가 없다. 범위를 넓혀 말하지 않기 위해 수치를
-- 여기 남긴다.
-- =============================================================================

alter table public.recall_cache
  add column if not exists hazard_type       text,
  add column if not exists recall_country    text,
  -- 공고에서 뽑아낸 위반 표준 번호 원문 ("EN 71-1", "GB 4706")
  add column if not exists cited_standards   text[] not null default '{}',
  -- 그중 우리가 보유한 KC 기준으로 대조된 것
  add column if not exists matched_standard_ids bigint[] not null default '{}',
  -- 이 리콜로 만들어진 사건 행 (트랙 A 와 같은 엔진을 타기 위한 통로)
  add column if not exists coded_at          timestamptz;

comment on column public.recall_cache.hazard_factor_code is
  '우리가 붙인 HF 코드. Recall Hub 는 이 필드를 주지 않는다(2026-09-01 실측)';
comment on column public.recall_cache.damage_type_codes is
  '우리가 붙인 DT 코드. 조항·사고와 같은 코드 공간이어야 대조가 된다';
comment on column public.recall_cache.hazard_type is
  'Recall Hub 원본의 위해유형 서술. 통제어휘가 아니므로 검색 조건으로 쓰지 않는다';
comment on column public.recall_cache.cited_standards is
  '공고에 명시된 위반 표준 번호. 전체의 27.9%에만 있다(EU 52% · CN 62% · 그 밖 0~5%)';
comment on column public.recall_cache.matched_standard_ids is
  '위 표준 중 보유 KC 기준으로 대조된 것. 컨셉 1.3 넷째 질문의 재료';

create index if not exists recall_cache_cited_idx
  on public.recall_cache using gin (cited_standards);

-- 국내 유통 동일성 확인은 별도 자료(통관·유통 DB)가 있어야 하므로 여기서는
-- 담당자가 확인한 결과만 받아 둔다. 시스템이 추정하지 않는다.
alter table public.recall_cache
  add column if not exists domestic_check text
    check (domestic_check in ('UNCHECKED', 'DISTRIBUTED', 'NOT_DISTRIBUTED', 'UNKNOWN'))
    default 'UNCHECKED';

comment on column public.recall_cache.domestic_check is
  '국내 유통 동일성. 담당자 확인 결과만 기록한다 — 제품안전기본법 13조 3항 보고의무 판단의 전제';
