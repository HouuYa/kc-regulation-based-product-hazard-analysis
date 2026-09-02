-- =============================================================================
-- KC안전기준(standard) GPC 매칭 — Brick→Class→Family→Segment 단계적 하향 반영
--
-- 담당자가 이 협회의 실제 운영 파이프라인(해외리콜 OECD 일일 처리,
-- docs/OECD리콜등록/[한국리콜__OECD] 리콜 생성시 (매일).json →
-- recalls_oecd_staging.assignedGpc{Brick,Segment,Family,Class}Code)을 짚어
-- 줬다. 그 파이프라인은 oecd_gpc_202405 를 그대로 쓰되(우리가 이미 쓰는
-- 것과 동일), Brick이 후보와 명확히 일치하지 않으면 NONE으로 포기하지
-- 않고 Class→Family→Segment로 단계적으로 내려가며 답하고, 그때도 상위
-- 계층 코드(Segment/Family/Class) 전부를 함께 저장한다 — Brick 하나는
-- 정확히 하나의 Class/Family/Segment 에 속하므로 같이 나온다.
--
-- 017의 gpc_verified_brick_code/gpc_verification(브릭 하나만 담는 이분법)을
-- 계층 전체를 담는 컬럼들로 바꾼다. 017이 이미 적용된 마이그레이션이라
-- 그 파일을 고치지 않고(§8 규칙) 새 파일로 이어 붙인다.
-- =============================================================================

alter table public.standard
  drop column if exists gpc_verified_brick_code;

alter table public.standard
  add column if not exists gpc_verified_level text
    check (gpc_verified_level in ('BRICK', 'CLASS', 'FAMILY', 'SEGMENT', 'NONE')),
  add column if not exists gpc_verified_segment_code text,
  add column if not exists gpc_verified_segment_title text,
  add column if not exists gpc_verified_family_code  text,
  add column if not exists gpc_verified_family_title  text,
  add column if not exists gpc_verified_class_code   text,
  add column if not exists gpc_verified_class_title   text,
  add column if not exists gpc_verified_brick_code    text,
  add column if not exists gpc_verified_brick_title    text;

comment on column public.standard.gpc_verified_level is
  'LLM이 검증한 매칭 계층 — BRICK/CLASS/FAMILY/SEGMENT/NONE(src/lib/gpc/verify.ts). NONE이면 아래 코드 컬럼이 전부 NULL이다. Brick이 후보와 명확히 안 맞으면 상위 계층으로 내려간다(해외리콜 OECD RAG 파이프라인과 동일 원칙) — 확정값이 아니라 담당자 검토용 후보다';
comment on column public.standard.gpc_verified_segment_code is 'gpc_verified_level 이 BRICK/CLASS/FAMILY/SEGMENT 중 하나면 항상 채워진다(가장 포괄적인 계층)';
comment on column public.standard.gpc_verified_family_code  is 'gpc_verified_level 이 BRICK/CLASS/FAMILY 면 채워진다';
comment on column public.standard.gpc_verified_class_code   is 'gpc_verified_level 이 BRICK/CLASS 면 채워진다';
comment on column public.standard.gpc_verified_brick_code   is 'gpc_verified_level 이 BRICK 일 때만 채워진다(가장 구체적인 계층)';
