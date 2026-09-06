-- =============================================================================
-- 법정 품목의 별칭 사전 — 일상어 ↔ 법정어
--
-- 무엇이 들어오나
--   협회의 「일일동향보고 검색용 데이터」에 담당자가 손으로 만들어 둔 키워드다.
--
--     전선 → 전기선 · 배선 · 콘센트 · 랜선 연결잭 · 피복선 · 전선줄
--     헤어드라이어 ⇒ 모발건조기      넥워머 ⇒ (비대상)온열팩
--
--   전기용품 156항목 754개 · 생활용품 53항목 242개 · 어린이제품 12항목 108개.
--
-- 왜 필요한가 (04-2 §1)
--   같은 물건을 다섯 군데서 다르게 부른다. 사고보고서는 담당자가 쓰는 글이라 법정어가
--   84%지만, 해외 리콜 1,553종은 6%만 법정어와 맞는다("토끼 나무 기차", "손 모양
--   플라스틱 끈적이 장난감"). 그 간극을 메우는 것이 이 표다.
--
-- 왜 scope_term 과 따로 두는가
--   scope_term 은 용어 → **기준**(standard_id)을 잇는다. 이 표는 용어 → **법정 품목**을
--   잇는다. 가리키는 곳이 다르다. 법정 품목은 product_taxonomy 를 거쳐 GPC 로도 가고
--   기준으로도 가므로, 한 단계 앞의 중심축이다.
--
-- 사람 것과 AI 것을 섞지 않는다
--   source 로 가른다. 사람이 만든 것은 그대로 쓰고, AI 가 만든 것은 검증을 거친다.
--   섞어 두면 나중에 "이 별칭은 누가 정했나"를 되짚을 수 없다.
-- =============================================================================

create table if not exists public.item_keyword (
  id            bigint generated always as identity primary key,

  -- 무엇을 가리키는가 (법정 품목 계층. product_taxonomy 와 논리 참조)
  item_group    text not null,           -- 전기용품 / 생활용품 / 어린이제품
  item          text,                    -- 품목
  sub_item      text,                    -- 세부품목. 있으면 이쪽이 더 정확한 지시 대상이다

  -- 일상에서 부르는 말
  keyword       text not null,
  -- 조회용으로 다듬은 형태. scope_term_key() 와 같은 규칙을 쓴다
  keyword_key   text not null,

  source        text not null check (source in ('EXPERT', 'LLM')),
  review_status text not null default 'auto_unreviewed'
                  check (review_status in ('auto_unreviewed', 'approved', 'rejected')),
  confidence    numeric,
  evidence      text,

  source_file   text,
  created_at    timestamptz not null default now()
);

-- 같은 말이 같은 품목에 두 번 들어가지 않게 한다.
-- 표 제약(unique …)에는 식을 쓸 수 없어 인덱스로 만든다 — sub_item·item 이 NULL 일 수
-- 있는데, NULL 은 서로 같지 않다고 보므로 coalesce 로 빈 문자열을 맞춰 줘야 중복이 막힌다.
create unique index if not exists item_keyword_uniq_idx
  on public.item_keyword (keyword_key, item_group, coalesce(sub_item, ''), coalesce(item, ''));

comment on table  public.item_keyword is
  '법정 품목의 별칭 사전. 일상어를 법정 품목으로 옮긴다(04-2 §5.3)';
comment on column public.item_keyword.source is
  'EXPERT 담당자가 만든 것(일일동향보고 검색용 데이터) / LLM 이 제안한 것(검증 대상)';
comment on column public.item_keyword.keyword_key is
  '조회용 형태. "LED 등기구"와 "LED등기구"가 같은 것으로 잡히게 한다';

create index if not exists item_keyword_key_idx
  on public.item_keyword (keyword_key) where review_status <> 'rejected';
create index if not exists item_keyword_target_idx
  on public.item_keyword (item_group, sub_item);
create index if not exists item_keyword_source_idx
  on public.item_keyword (source, review_status);

alter table public.item_keyword enable row level security;
revoke all on table public.item_keyword from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 검색에서 빼는 말
-- -----------------------------------------------------------------------------
-- 같은 파일의 「일일동향보고 검색 제외어」다. 위해유형 이름처럼 품목이 아닌 말이
-- 섞여 들어오면 엉뚱한 품목에 걸린다.
create table if not exists public.item_keyword_stopword (
  word        text primary key,
  word_key    text not null,
  source_file text,
  created_at  timestamptz not null default now()
);

comment on table public.item_keyword_stopword is
  '품목 매칭에서 제외할 말. 협회 「일일동향보고 검색 제외어」';

alter table public.item_keyword_stopword enable row level security;
revoke all on table public.item_keyword_stopword from anon, authenticated;
