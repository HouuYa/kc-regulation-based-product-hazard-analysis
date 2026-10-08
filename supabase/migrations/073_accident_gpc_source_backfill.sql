-- =============================================================================
-- 사고보고서 GPC 의 출처를 채운다
--
-- 기능 지도(docs/기능_지도.md)를 만들며 찾은 어긋남이다. 사고보고서에 이 체계 AI 가
-- 붙인 GPC 가 8건 있는데 gpc_source 가 71건 전부 비어 있었다 — process-photos.ts 가
-- 출처를 적지 않았다. 출처가 비면 검수 화면이 「이건 확인해야 하는 값인가」를 말해 줄 수
-- 없고, 서열(EXPERT > OECD > SOURCE_AI > OUR_AI, lib/gpc/provenance.ts)로 덮어쓰기를
-- 막을 수도 없다.
--
-- 코드는 같은 라운드에 고쳤다(process-photos.ts 가 이제 OUR_AI 를 적는다). 여기서는
-- 이미 들어간 값만 채운다. GPC 검증 결과가 있는데 출처가 비어 있는 사고보고서가 대상이다.
-- =============================================================================

update public.case_event
set gpc_source = 'OUR_AI'
where source_type = 'ACCIDENT'
  and gpc_source is null
  and (gpc_verified_level is not null or gpc_brick_code is not null);
