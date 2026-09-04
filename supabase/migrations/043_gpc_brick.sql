-- =============================================================================
-- GPC 브릭을 우리 쪽에 들인다 — 정의문과 한국어를 함께 둔다
--
-- 왜 우리가 갖는가
--   지금은 협회의 별도 Supabase(fczencruxulddednkint)에 있는 벡터 색인
--   oecd_gpc_202405 를 빌려 쓴다. 그 방식에 세 가지 한계가 있다.
--
--     1) 판이 2024-05 다. GS1 은 연 2회(5월·11월) 내고 지금 최신은 2026-05 이라
--        네 판 뒤처져 있다.
--     2) 제목만 있고 정의문(Definition)이 없다. GPC 의 브릭 제목은 짧아서
--        "개인용 온열/마사지용품 (동력)" 처럼 여러 물건을 뭉뚱그린다. 정의문에는
--        무엇이 들어가고 무엇이 빠지는지가 적혀 있다 — 뜻으로 맞출 때 이것이 크다.
--     3) 남의 프로젝트다. 실제로 그쪽 edge function 의 OpenAI 크레딧이 말라
--        항상 429 로 실패한 적이 있다(lookup.ts 주석). 우리가 못 고치는 고장이다.
--
--   GS1 은 인증·등록·결제 없이 공개 배포한다(실측 2026-09-04).
--
--     https://ref.gs1.org/standards/gpc/2026-05/  →  200 application/zip 11.1MB
--     안에 EN.json(32.6MB) · EN.xml · EN.xlsx · Delta(판 간 차이) · 릴리스 노트
--
--   Delta 파일이 있어 다음 판부터는 바뀐 것만 반영하면 된다.
--
-- 한국어는 어디서 오는가
--   GS1 정본은 Oxford English 뿐이다. 한국어 제목은 협회 색인에 있으므로
--   브릭 코드를 공통 키로 조인해 붙인다. 코드는 양쪽이 같은 GS1 코드다.
--
-- 이 표로 무엇을 하고 무엇을 하지 않는가 — 실측으로 정한 경계
--   한다:    사고와 리콜을 같은 품목군으로 묶는다. 해외 리콜은 영어로, 우리
--            사고는 한국어로 적히므로 언어에 독립적인 키가 필요하다.
--            3번째 산출물의 사각지대 집계가 이 단위로 센다.
--
--   하지 않는다: 기준 선택. 담당자가 만든 엑셀을 세어 보니 한 브릭이 여러 품목을
--            묶는 4건 중 3건에서 기준이 서로 달랐다.
--
--              10000759 개인용 온열/마사지용품 (동력)
--                눈마사지기   → KC 60335-2-17 + 부속서 74
--                손목마사지기  → KC 60335-1 + KC 60335-2-17
--                전기찜질기   → KC 60335-1 + KC 60335-17 + KC 60335-2-17
--
--            반대로 같은 품목이 여러 브릭에 걸리기도 한다(LED등기구 → 10008403,
--            10008404). GPC 는 유통 분류이고 KC 기준은 위해·기능 분류라 축이 다르다.
--            기준 선택은 용어 사전(042 scope_term)이 맡는다.
-- =============================================================================

create table if not exists public.gpc_brick (
  brick_code     text primary key,

  brick_title_en text not null,
  brick_title_ko text,
  definition_en  text,
  excludes_en    text,

  class_code     text not null,
  class_title_en text,
  class_title_ko text,

  family_code    text not null,
  family_title_en text,
  family_title_ko text,

  segment_code   text not null,
  segment_title_en text,
  segment_title_ko text,

  active         boolean not null default true,
  /** 어느 판에서 왔는가. 판올림 때 무엇이 바뀌었는지 되짚는다 */
  gpc_version    text not null,

  /** 뜻으로 찾을 때 쓰는 문장. 한국어·영어·정의문을 함께 담는다 */
  search_text    text,
  embedding      extensions.vector(1536),
  embedding_model text,

  updated_at     timestamptz not null default now()
);

comment on table public.gpc_brick is
  'GS1 GPC 브릭. 품목군을 묶는 언어 독립 키로 쓴다 — 기준 선택에는 쓰지 않는다(축이 다르다)';
comment on column public.gpc_brick.definition_en is
  'GPC 정의문. 브릭 제목이 짧아 뭉뚱그려지는 것을 이 문장이 갈라 준다';
comment on column public.gpc_brick.brick_title_ko is
  '협회 색인(oecd_gpc_202405)에서 브릭 코드로 조인해 붙인 한국어. GS1 정본은 영어뿐이다';

create index if not exists gpc_brick_segment_idx on public.gpc_brick (segment_code, family_code, class_code);
create index if not exists gpc_brick_active_idx  on public.gpc_brick (active) where active;

-- 뜻으로 찾기. 조항·사건과 같은 방식이다(006 참고)
create index if not exists gpc_brick_embedding_idx
  on public.gpc_brick using hnsw (embedding extensions.vector_cosine_ops);

alter table public.gpc_brick enable row level security;
revoke all on table public.gpc_brick from anon, authenticated;
