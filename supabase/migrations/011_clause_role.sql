-- =============================================================================
-- 조항 역할 (v0.7 §5.3 "조항 유형과 관계")
--
-- 조항을 모두 같은 검색 대상으로 취급하지 않는다. v0.7 이 준 표를 컬럼으로 옮긴다.
--
--   REQUIREMENT  성능요건 — 주 검색 대상. 태깅 대상은 이것뿐이다
--   TEST_METHOD  시험방법 — clause_link 로 도달하므로 직접 검색하지 않는다
--   SCOPE        적용범위 — 품목 범위 해석에만 쓴다
--   REFERENCE    인용·관련 표준
--   DEFINITION   용어의 정의
--   MARKING      표시·주의사항 — 트랙별 선택
--   ANNEX        부록·참고
--   FRAGMENT     표·그림·비고
--
-- 왜 넣는가 (실측으로 확인한 오염)
--   역할 구분 없이 태깅했더니 "가량이 벨트란 …장치를 말한다"(용어의 정의)에
--   HF.M.DES + DT.MECHANICAL.FALL 이 일치도 1.0 으로 붙었다. 정의문은 아무것도
--   요구하지 않으므로 시험 후보가 될 수 없는데, 코드가 붙으면 진짜 안전요건과
--   같은 자격으로 검색에 걸린다. §5.8 정확도를 재기 전에 막아야 한다.
--
-- 검색 함수를 고치지 않아도 되는 이유
--   search_text 와 embedding 은 태깅 단계에서 채워진다. 태깅하지 않으면 둘 다
--   비어 있고, 키워드 갈래는 search_text 를, 의미 갈래는 embedding 을 조건으로
--   걸기 때문에 자동으로 후보에서 빠진다. 코드 갈래도 태그가 없으니 걸리지 않는다.
-- =============================================================================

alter table public.clause
  add column if not exists clause_role text;

comment on column public.clause.clause_role is
  'v0.7 5.3 조항 유형. REQUIREMENT 만 태깅·검색 대상이고 TEST_METHOD 는 관계 확장으로 도달한다';

-- 태깅 대상을 고르는 질의가 이 컬럼으로 걸러지므로 인덱스를 둔다
create index if not exists clause_role_idx
  on public.clause (standard_id, clause_role);
