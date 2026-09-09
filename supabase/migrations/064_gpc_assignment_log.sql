/*
  품목분류를 어떻게 붙였는지 한 곳에 남긴다 (064)

  담당자가 협회 워크플로(docs/OECD리콜등록/「(GS1) [한국리콜__OECD] OECD GPC RAG」)를
  짚으며 물었다 — "LLM 이 부여하는데, GPC 코드 찾는 절차와 코드뿐만 아니라 사유도
  적고 있어요. 이 로직이 적용되어 있는 거죠?" 그리고 "보다 일반적으로 만들면서
  보강해 달라"고 했다.

  절반은 이미 같았다
    계층을 Brick → Class → Family → Segment 로 한 단계씩 내려가며 「이 Brick 이 정말
    이 제품을 가리키는가」를 따지는 순서도, 왜 그 코드를 골랐는지 사유를 남기는 것도
    같다. 오히려 우리 쪽이 한 겹 더 단단하다 — 코드를 후보 목록의 열거값으로 못박아
    없는 코드를 지어낼 수 없게 했고, 고른 코드가 어느 계위이고 그 위가 무엇인지는
    모델의 자기보고 대신 서버가 판정해 채운다.

  빠져 있던 것 둘
    1) 「무엇으로 찾았는가」. 그쪽은 search_strategy_description 한 칸에 검색 전략과
       판단 근거를 함께 말로 적게 한다. 우리는 판단 근거만 남겨, 검수하는 사람이
       "그럼 뭘로 검색한 건데"를 되짚을 수 없었다.
    2) 기록이 대상마다 흩어져 있었다. 기준은 standard.gpc_candidates, 사건은
       case_event.gpc_candidates, 품목은 scope_term_gpc — 같은 판정인데 모양이
       셋이라 「AI 가 품목분류를 어떻게 붙이고 있나」를 한 번에 볼 수가 없었다.

  그래서 대상을 가리지 않는 기록표를 하나 만든다
    말로 적게 하는 대신 사실을 남긴다 — 실제로 보낸 질의문(query_text)과 그때 실제로
    돌아온 후보 목록(candidates). 모델이 적은 설명은 틀릴 수 있지만 이 둘은 우리가
    보내고 받은 것이라 틀릴 수 없다. 검수자는 이 둘로 「후보에 정답이 아예 없었는지」와
    「후보엔 있었는데 모델이 잘못 골랐는지」를 가른다. 원인이 다르면 고칠 곳도 다르다 —
    앞은 색인이나 질의문 문제이고 뒤는 프롬프트 문제다.

  각 대상 표의 칸은 그대로 둔다
    scope_term_gpc·standard·case_event 의 기존 칸은 「지금의 답」이고 사람이 검수해
    확정하는 자리다. 이 표는 「그 답이 어떻게 나왔는가」의 이력이라 역할이 다르다.
    답은 덮어써도 이력은 쌓인다.
*/

create table if not exists public.gpc_assignment (
  id            bigserial primary key,

  -- 무엇에 붙였나. ADHOC 은 API 로 한 번 물어본 것(어디에도 저장되지 않는 조회)
  subject_type  text not null check (subject_type in ('TERM', 'STANDARD', 'CASE', 'ADHOC')),
  -- TERM 은 term_key, STANDARD·CASE 는 id 를 문자열로. 대상 표가 서로 달라 외래키를 걸지 않는다
  subject_key   text not null,
  -- 사람이 읽을 대상 이름. 나중에 대상 행이 지워져도 무엇이었는지 남는다
  subject_label text,

  -- 무엇으로 찾았나
  query_text    text not null,
  candidates    jsonb not null default '[]'::jsonb,

  -- 무엇을 골랐나. level 이 BRICK 이 아니면 그 아래 칸은 비어 있다
  level         text not null check (level in ('BRICK', 'CLASS', 'FAMILY', 'SEGMENT', 'NONE')),
  brick_code    text,
  brick_title   text,
  class_code    text,
  class_title   text,
  family_code   text,
  family_title  text,
  segment_code  text,
  segment_title text,

  -- 왜 그렇게 골랐나
  confidence    numeric,
  reasoning     text,
  model         text,

  -- 사진을 읽어 질의문을 보탠 경우 그 판독 결과. 안 썼으면 null
  image_reading jsonb,

  created_at    timestamptz not null default now()
);

comment on table public.gpc_assignment is
  '품목분류(GPC) 판정 이력 — 대상(품목·기준·사건·즉석조회)을 가리지 않고 한 곳에 쌓는다. 무엇으로 찾았고(query_text) 후보가 무엇이었고(candidates) 왜 골랐는지(reasoning)를 남긴다(064)';
comment on column public.gpc_assignment.query_text is
  '벡터 색인에 실제로 보낸 문장. 모델이 적은 설명과 달리 이것은 사실이다';
comment on column public.gpc_assignment.candidates is
  '조회에서 돌아온 후보 목록(계위·유사도 포함). 후보에 정답이 없었는지, 있었는데 잘못 골랐는지를 가른다';
comment on column public.gpc_assignment.level is
  '어디까지 좁혔나 — BRICK 이 가장 아래. 그 위에서 멈춘 것은 「GPC 에 없다」가 아니라 「후보가 갈려 못 좁혔다」는 뜻이다';
comment on column public.gpc_assignment.image_reading is
  '제품 사진을 읽어 질의문을 보탠 경우 그 판독 결과(src/lib/gpc/describe-image.ts)';

create index if not exists gpc_assignment_subject_idx
  on public.gpc_assignment (subject_type, subject_key, created_at desc);
create index if not exists gpc_assignment_created_idx
  on public.gpc_assignment (created_at desc);
create index if not exists gpc_assignment_brick_idx
  on public.gpc_assignment (brick_code) where brick_code is not null;

revoke all on public.gpc_assignment from anon, authenticated;
