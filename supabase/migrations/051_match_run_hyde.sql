-- =============================================================================
-- HyDE 가 지어낸 가상 조항을 남긴다
--
-- 무엇이 비어 있었나 (2026-09-07, 담당자 질문 "판단 근거를 DB에 저장하는가")
--   LLM 호출 여덟 곳을 감사했더니 일곱 곳은 근거를 돌려받아 저장하고 있었다.
--
--     적용범위 의미검색  reasoning  → scope_term.evidence · case_event.scope_evidence
--     적용범위 후보 거르기 reasoning  → case_event.scope_evidence
--     품목 기준 제안     reason     → scope_term.evidence
--     GPC 검증          reasoning  → standard.gpc_verification (JSON)
--     조항 재채점        reason     → match_result.rerank_reason
--     코드 부여         evidence_span → case_tag · clause_tag
--     법정 품목 잇기     reasoning  → taxonomy_standard.evidence
--
--   HyDE 만 빠져 있었다. 그런데 hyde.ts 는 돌려주는 값에 이렇게 적어 두었다 —
--   "화면에 보이지 않는다 — **되짚기 위해** 돌려줄 뿐이다". 정작 부르는 쪽(run.ts)은
--   임베딩만 꺼내 쓰고 그 문단을 버리고 있었다. 적어 둔 의도가 지켜지지 않은 것이다.
--
-- 왜 남겨야 하나
--   HyDE 는 사고 서술로 "답에 해당할 법한 조항"을 지어내 의미 갈래의 질의로 쓴다.
--   즉 **어떤 조항이 후보로 떠오르는지를 바꾼다**(재현율 23.8% → 25.2%). 그런데
--   지어낸 문단이 남지 않으면 담당자가 "왜 이 조항이 나왔지?"를 되짚을 때 그 자리가
--   빈칸이 된다. 031 이 query_text·query_keywords 를 남긴 것과 같은 까닭이다 —
--   "어떤 질문에서 나온 결과인지 증명할 수 있어야 한다".
--
--   지어낸 문단은 기준 원문이 아니다. 화면에 그대로 보이면 담당자가 실제 조항으로
--   오해할 수 있으므로, 저장은 하되 보여 줄 때는 "AI 가 지어낸 검색용 문장"임을
--   반드시 밝힌다.
-- =============================================================================

alter table public.match_run
  add column if not exists hyde_text text;

comment on column public.match_run.hyde_text is
  'HyDE 가 지어낸 가상 조항. 의미 검색의 질의로 쓴 문장이며 기준 원문이 아니다 — 되짚기용(051)';
