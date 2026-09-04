-- =============================================================================
-- 분석 1회를 그대로 되짚을 수 있게 한다 — 빠져 있던 세 가지를 채운다
--
-- 무엇이 빠져 있었나 (02_1차 보완 및 구현 설계서 §4.5)
--   match_run 은 이미 갈래 스위치·융합 가중치·후보 수·모델명을 남긴다. 결과도
--   match_result 에 탈락 후보까지 보존한다. 여기까지는 설계문서 §5.6.3 대로다.
--
--   그런데 "무엇을 물었는가"가 없다. 조회에 쓴 질의 원문과 검색어가 남지 않아,
--   나중에 같은 사건을 다시 열었을 때 그때와 같은 질문이었는지 확인할 수 없다.
--   사건의 narrative 는 그 뒤에 바뀔 수 있다 — 리콜은 원본이 갱신되면 서술이
--   따라 바뀐다(load.ts). 즉 지금은 "그때 이 문장으로 물었다"를 증명할 수 없다.
--
--   리랭킹 실패도 성공과 구분되지 않는다. 리랭커가 죽으면 rerank_score 가 전부
--   null 인 채로 저장되는데, 이것은 "리랭커가 다 낮게 줬다"와 화면에서 같아 보인다.
--
-- 무엇을 더하는가
--   query_text      그때 실제로 던진 질의 원문
--   query_keywords  그때 쓴 검색어
--   rerank_status   리랭킹을 했는가·건너뛰었는가·실패했는가
--   prompt_version  리랭커 프롬프트·모델 묶음의 판번호
--
-- 왜 사건에서 다시 읽어 오면 안 되는가
--   원본이 바뀌면 사건도 바뀌기 때문이다. 분석 기록은 그 시점의 사진이어야 한다.
--   같은 이유로 코드도 이미 queried_hf_codes 로 따로 남기고 있다.
-- =============================================================================

alter table public.match_run
  add column if not exists query_text     text,
  add column if not exists query_keywords text[] not null default '{}',
  add column if not exists prompt_version text,
  add column if not exists rerank_status  text not null default 'skipped'
    check (rerank_status in ('skipped', 'ok', 'failed'));

comment on column public.match_run.query_text is
  '그때 실제로 던진 질의 원문. 사건 서술이 나중에 바뀌어도 이 값은 그대로다';
comment on column public.match_run.query_keywords is
  '그때 쓴 검색어. 키워드 갈래가 무엇에 걸렸는지 되짚을 때 쓴다';
comment on column public.match_run.prompt_version is
  '리랭커 모델·프롬프트 묶음의 판번호. 태깅의 tagging_version 과 같은 구실';
comment on column public.match_run.rerank_status is
  'skipped=끄고 돌림 / ok=재채점 완료 / failed=리랭커 호출 실패. '
  'failed 를 성공처럼 저장하면 "리랭커가 다 낮게 줬다"와 구별되지 않는다';

-- 지난 실행에는 이 값들이 없다. 없는 것과 "빈 질의로 돌렸다"를 섞지 않기 위해
-- query_text 는 null 을 그대로 둔다 — 화면은 null 이면 "기록 없음"으로 적는다.
--
-- rerank_status 는 기본값 'skipped' 로 채워지는데, 이것이 옛 기록에 대해서도
-- 틀린 말은 아니다. 다만 use_rerank 가 켜져 있던 실행은 실제로는 재채점을 했으므로
-- 한 번만 되짚어 맞춰 준다.
update public.match_run
set rerank_status = 'ok'
where use_rerank
  and rerank_model is not null
  and exists (
    select 1 from public.match_result mr
    where mr.run_id = match_run.id and mr.rerank_score is not null
  );
