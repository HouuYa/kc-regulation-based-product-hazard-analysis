-- =============================================================================
-- Storage 버킷 — 원본 파일 보관 (설계문서 §7.1 원본층)
--
-- putOriginal()(src/lib/supabase/server.ts)이 쓰는 버킷이다. 사고보고서 PDF·
-- 코드북 MD·안전기준 JSON 원본을 여기 둔다. 원본은 불변이고 덮어쓰지 않는다 —
-- 이것이 사라지면 태깅·임베딩·매칭은 다시 만들 수 있어도 원본 자체는 못 만든다.
--
-- public=false 인 이유: 개인정보 가능성이 있는 사고보고서 원본을 포함하므로
-- 익명 읽기를 허용하지 않는다. 서버(service_role)만 읽고 쓴다 — RLS 를 켜 둔
-- 다른 표들과 같은 원칙(§1.3.3).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'originals', 'originals', false, 26214400,
  array['application/pdf', 'text/markdown', 'application/json', 'text/plain']
)
on conflict (id) do nothing;
