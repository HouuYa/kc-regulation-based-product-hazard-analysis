/*
  품목분류를 어떻게 찾았는지 남긴다 (064)

  담당자가 협회 워크플로(docs/OECD리콜등록/「(GS1) [한국리콜__OECD] OECD GPC RAG」)를
  짚으며 물었다 — "LLM 이 부여하는데, GPC 코드 찾는 절차와 코드뿐만 아니라 사유도
  적고 있어요. 이 로직이 적용되어 있는 거죠?"

  절반은 이미 적용돼 있었다. 계층을 Brick → Class → Family → Segment 로 한 단계씩
  내려가며 「이 Brick 이 정말 이 제품을 가리키는가」를 따지는 순서도, 왜 그 코드를
  골랐는지 사유를 남기는 것도 같다. 오히려 우리 쪽이 한 겹 더 단단하다 —
  코드를 후보 목록의 열거값으로 못박아 없는 코드를 지어낼 수 없게 했고, 고른 코드가
  어느 계위이고 그 위가 무엇인지는 모델의 자기보고 대신 서버가 판정해 채운다.

  빠져 있던 것은 「무엇으로 찾았는가」다. 그쪽은 `search_strategy_description` 한 칸에
  검색 전략과 판단 근거를 함께 말로 적게 한다. 우리는 판단 근거만 남기고 있어서,
  검수하는 사람이 "그럼 뭘로 검색한 건데"를 되짚을 수 없었다.

  말로 적게 하는 대신 사실을 남긴다
    query_text   벡터 색인에 실제로 보낸 문장
    candidates   그때 실제로 돌아온 후보 목록(계위·유사도 포함)
  모델이 적은 설명은 틀릴 수 있지만 이 둘은 우리가 보내고 받은 것이라 틀릴 수 없다.
  검수 화면은 이 둘을 펼쳐 보여, 담당자가 「후보에 정답이 아예 없었는지」와
  「후보엔 있었는데 모델이 잘못 골랐는지」를 구별할 수 있게 한다. 원인이 다르면
  고칠 곳도 다르다 — 앞은 색인이나 질의문 문제이고 뒤는 프롬프트 문제다.
*/

alter table public.scope_term_gpc
  add column if not exists query_text text,
  add column if not exists candidates  jsonb;

comment on column public.scope_term_gpc.query_text is
  '벡터 색인에 실제로 보낸 질의문. 「무엇으로 찾았는가」를 되짚는 자리(064)';
comment on column public.scope_term_gpc.candidates is
  '조회에서 돌아온 후보 목록(계위·유사도 포함). 후보에 정답이 없었는지, 있었는데 잘못 골랐는지를 가른다(064)';
