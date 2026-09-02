-- =============================================================================
-- 해외 리콜 — 원본 표(Recall Hub 관리자 Supabase) 직접 접근으로 전환
--
-- 008/013 이 쓸 때 전제로 삼은 얇은 REST API(RECALL_HUB_API_KEY, 16개 필드) 대신,
-- 담당자가 검토·승인(approval_status)까지 마치고 위해요인(HF-DT)까지 분류해 둔
-- recalls 원본 표를 직접 읽는다(src/lib/recall/source.ts, 2026-09-02 결정).
--
-- 실측(2026-09-02, project xicivtmjfkpuehgsieex)
--   전체 4,828건 중 approved 2,252 / rejected 2,565 / pending 11
--   approved 건은 hazard_factor_code · damage_type_primary · iso5665_severity 가
--   전부(0건 결측) 채워져 있다 — API 시절 우리가 대신 붙이던 자체 LLM 태깅
--   (recalls:code, RECALL_OVERSEAS) 을 더 이상 돌리지 않아도 된다.
--
--   다만 관리자 쪽 HF 코드 중 일부가 우리 코드북(v0.9.7)과 안 맞았다.
--   `HF.S.STD` (approved 건 중 주코드 40건·부코드 155건) 는 PDR 부록 J 변경이력에
--   v0.9 에서 8개 세분코드로 쪼개지며 deprecated 된 코드다 — Recall Hub 쪽 분류가
--   그 전 버전 코드북을 기준으로 돌고 있다는 뜻이다(거버넌스 동기화 필요, 담당자 확인 중).
--   `HF.M.REG.VIOL` (1건) 은 애초에 존재한 적 없는 코드로 보인다 — 우리 코드북엔
--   `HF.M.REG.ILLEGAL`/`UNMANAGED` 와 별도로 `HF.M.VIOL`(내부규정 위반) 이 있는데
--   둘을 합쳐 잘못 붙인 것으로 추정된다. 적재 스크립트가 코드북에 없는 코드는
--   버리고 "미분류" 로 남긴다 — 임의로 매핑하지 않는다.
-- =============================================================================

alter table public.recall_cache
  add column if not exists iso5665_severity       integer,
  add column if not exists approval_status         text,
  add column if not exists classification_confidence real,
  add column if not exists injuries_count          integer,
  add column if not exists has_confirmed_injuries  boolean,
  -- 원본 표의 자체 id. 담당자에게 특정 건을 되짚어 물을 때 쓴다(recalls.id)
  add column if not exists source_row_id           bigint;

comment on column public.recall_cache.iso5665_severity is
  '원본 표의 심각도 점수(관리자 판정). 우리 쪽 척도가 아니므로 그대로 참고만 한다';
comment on column public.recall_cache.approval_status is
  '원본 표 담당자 검토 상태. 이 값이 approved 인 것만 적재한다(source.ts)';
comment on column public.recall_cache.classification_confidence is
  '원본 표의 classification_confidence 는 제품분류(product_categories) 확신도다.
   위해요인(HF-DT) 확신도가 아니므로 case_tag.confidence_score 계산에는 쓰지 않는다
   — 착각하기 쉬워 남겨 두는 주석(2026-09-02 확인)';

-- -----------------------------------------------------------------------------
-- 부수 발견 — case_event 재실행 시 중복 생성 버그
--
-- load-recalls.ts 가 `on conflict do nothing` 으로 case_event 중복을 막으려 했는데
-- external_ref 에 유니크 제약이 없어 실제로는 막히지 않았다(재실행마다 같은 리콜이
-- 새 행으로 또 들어간다). 이번에 이 표를 다시 만지면서 발견해서 같이 고친다.
-- -----------------------------------------------------------------------------
create unique index if not exists case_event_source_external_ref_idx
  on public.case_event (source_type, external_ref)
  where external_ref is not null;
