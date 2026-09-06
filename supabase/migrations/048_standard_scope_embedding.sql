-- =============================================================================
-- 적용범위 임베딩을 저장해 둔다
--
-- 왜 필요한가
--   scope-semantic.ts 는 품목 → 기준을 뜻으로 찾을 때 **호출마다 적용범위 73개를
--   전부 다시 임베딩한다**(embedBatch([query, ...stds])). 사건 하나를 볼 때는 견딜
--   만하지만, 법정 품목 187종을 배치로 이으려면 73×187 번을 임베딩하게 된다.
--
--   적용범위는 기준을 다시 적재하기 전에는 바뀌지 않는다. 한 번 계산해 두고 쓴다.
--
-- 모델을 함께 적는 이유 (002 와 같은 까닭)
--   모델이 바뀌면 좌표계가 달라져 유사도가 조용히 망가진다. 오류가 나지 않고
--   결과만 나빠지는 종류라, 무엇으로 만든 벡터인지 남겨야 나중에 알아챌 수 있다.
--
-- 되돌아갈 길을 남긴다
--   이 칸이 비어 있으면 scope-semantic 은 지금처럼 그 자리에서 계산한다.
--   채우는 것은 최적화이지 전제가 아니다.
-- =============================================================================

alter table public.standard
  add column if not exists scope_embedding    extensions.vector(1536),
  add column if not exists scope_embedded_at  timestamptz,
  add column if not exists scope_embedding_model text;

comment on column public.standard.scope_embedding is
  '적용범위 원문의 벡터. 품목을 뜻으로 이을 때 후보를 좁히는 데 쓴다(scope-semantic.ts)';
comment on column public.standard.scope_embedding_model is
  '어떤 모델로 만든 벡터인가. 없으면 모델 교체 시 좌표계가 섞여 조용히 망가진다';

-- 적용범위가 있는 것만 채운다. 부분 인덱스로 훑을 대상을 좁힌다
create index if not exists standard_scope_embedded_idx
  on public.standard (scope_embedded_at)
  where scope_text is not null;
