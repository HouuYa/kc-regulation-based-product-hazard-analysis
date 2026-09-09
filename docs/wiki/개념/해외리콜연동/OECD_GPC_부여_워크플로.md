---
created: 2026-09-09
updated: 2026-09-09
description: 협회 n8n 워크플로가 OECD GPC 코드를 어떻게 부여하는지, 이 저장소의 src/lib/gpc/가 그 방식에서 무엇을 그대로 가져오고 무엇을 더 단단하게 고쳤는지
status: active
related: [../GPC/표준제품분류체계_K-GPC.md, ../../색인.md]
sources: [docs/raw/OECD리콜등록/(GS1) [한국리콜__OECD] OECD GPC RAG.json]
---

# OECD GPC 부여 워크플로

## 0. 이 문서의 출처

협회 n8n 워크플로 원본(`(GS1) [한국리콜__OECD] OECD GPC RAG.json`)을 직접 읽고
정리했다. 이 워크플로가 이 저장소 `src/lib/gpc/`의 설계 근거가 됐다는 점은
`src/lib/gpc/lookup.ts`·`verify.ts`·`classify.ts` 파일 머리 주석에 이미
적혀 있었다 — 이 문서는 그 원본 워크플로 자체를 원자료로 삼아 무엇을 그대로
가져왔고 무엇을 고쳤는지 한 곳에 정리한 것이다.

## 1. 워크플로가 하는 일 — 두 단계

이름은 하나지만 실제로는 두 개의 독립된 흐름이 한 파일에 들어 있다.

**색인 만들기 (임베딩)** — 폼으로 CSV(세그먼트·패밀리·클래스·브릭 코드+명칭)를
올리면, Code 노드가 계층을 4단으로 조립해 "Brick: …; Class: …; Family: …;
Segment: …;" 형태의 한 줄 문서(`document_text`)를 만들고, OpenAI 임베딩을
거쳐 Supabase 벡터표 `oecd_gpc_202405`에 넣는다. 검색 쿼리 이름은
`match_documents_202405`다.

**GPC 부여 (검색+판정)** — 다른 워크플로가 `product_name`·
`product_description`을 넘기며 이 워크플로를 하위 워크플로로 호출한다.
LangChain 에이전트(AI Agent1, `gpt-5.5`)가 `oecd_gpc_202405`를 벡터 검색
도구로 딱 한 번만 호출하도록 프롬프트로 강제하고("You MUST call the vector
search tool only once"), 받은 후보로 최종 코드를 고른다.

## 2. 판정 프롬프트의 핵심 — 엄격한 적합성 평가 + 단계적 하향

프롬프트가 요구하는 순서는 이렇다.

1. **Brick 코드부터 본다.** 후보 Brick의 정의·용도·범위가 입력 제품의 핵심
   기능·특성·일반적 사용 사례와 **명확하고 구체적으로** 일치해야 채택한다.
   예로 든 실패 사례가 그대로 프롬프트에 있다 — "선풍기"를 찾는데 "창문/배기용
   팬" Brick이 나온 경우, 포괄적이거나 다른 유형을 가리키므로 부적합 처리한다.
2. **Brick이 부적합하면 포기하지 않고 Class로 대체**하고, Class도 안 맞으면
   Family로, Family도 안 맞으면 Segment로 한 단계씩 더 내려간다.
3. **코드·명칭은 반드시 RAG가 준 값 그대로**여야 한다 — "절대 RAG 데이터에
   존재하지 않는 숫자를 산출하지 마십시오"라고 못박는다.
4. 무엇을 검색했고 왜 그 코드를(혹은 상위 코드를) 골랐는지를
   `search_strategy_description`이라는 자유 서술 칸에 한국어로 남긴다.

## 3. 이 저장소의 이식본이 그대로 가져온 것

- **벡터표·RPC를 그대로 재사용한다.** `src/lib/gpc/lookup.ts`는 협회의 별도
  Supabase 프로젝트에 있는 `oecd_gpc_202405`·`match_documents_202405`를 anon
  키로 직접 호출한다 — 데이터를 복제하지 않고 원본 색인을 그대로 쓴다.
- **Brick→Class→Family→Segment 단계적 하향 원칙**을 그대로 따른다.
  `src/lib/gpc/verify.ts`의 시스템 프롬프트("엄격한 적합성 평가")는 위 §2의
  Brick 적합성 판단 로직을 거의 그대로 옮긴 것이다. "억지로 가장 비슷해 보이는
  Brick을 고르지 않는다 — 틀린 Brick을 확정하는 것보다 정직한 Class/Family/
  Segment나 NONE이 낫다"는 문구가 원본의 취지를 이어받는다.
- **"무엇으로 찾아 무엇을 골랐는지"를 남긴다는 목적**도 같다. 다만 방식은
  다르게 고쳤다 — 아래 §4.

## 4. 이식본이 더 단단하게 고친 것

| 항목 | 원본 워크플로 | 이 저장소 |
| --- | --- | --- |
| 코드 환각 방지 | 프롬프트로 "존재하지 않는 숫자를 산출하지 마라"고 지시 | `verify.ts`가 후보 목록의 Brick/Class/Family/Segment 코드를 모아 **JSON 스키마 enum으로 못박는다** — 모델이 목록에 없는 코드를 구조적으로 못 낸다(`tagging.ts`의 `validateCodes()`와 같은 원리) |
| 계층(Brick인지 Class인지) 판정 | 모델이 스스로 `brick_code`/`class_code`/… 필드를 채운다(자기보고) | 모델은 `selected_code` **하나만** 고르고, 그 코드가 후보 목록의 어느 계층에 속하는지와 상위 계층 전체를 **서버(`resolveHierarchy()`)가 결정론적으로 판정**한다. 모델의 계층 자기보고를 믿지 않는다 — 코드와 계층이 어긋나는 사고를 막기 위해서다 |
| 검색 과정 기록 | `search_strategy_description`이라는 **모델이 쓴 설명 문장**만 남는다 | 모델이 실제로 벡터 검색에 **보낸 질의문(`queryText`)과 받은 후보 목록 전체**를 그대로 남긴다(`findGpcCandidatesWithQuery()`). 모델이 적은 설명은 틀릴 수 있지만 실제로 보낸 질의문은 사실이라는 것이 이유다 |
| 검색 횟수 | 프롬프트로 "딱 한 번만 호출하라"고 지시(에이전트가 도구 호출을 반복할 수 있는 구조라 지시로 막음) | 애초에 에이전트 루프가 아니라 **정해진 순서의 함수 호출**(`lookup → verify`)이라 여러 번 검색할 구조 자체가 없다 |
| 후보 개수 | 도구 설명에 `topK: 5` 고정 | `DEFAULT_GPC_CANDIDATE_COUNT = 15`. 라운드 10 실측에서 5개로는 정답이 후보 밖으로 밀리는 사례가 나와 늘렸다(`lookup.ts`) |
| 이력 | 없음(워크플로 실행 로그만 n8n에 남음) | `gpc_assignment` 표에 대상(TERM/STANDARD/CASE/ADHOC)을 가리지 않고 질의문·후보·판정을 함께 쌓는다(`record.ts`, 064) — 같은 품목을 다시 돌리면 두 판정을 나란히 놓고 왜 달라졌는지 볼 수 있다 |
| 신고된 코드 우선 사용 | 해당 없음(이 워크플로 자체가 코드를 새로 부여하는 쪽) | `classify.ts` 0단계 — 리콜 원본이 이미 OECD 신고 코드를 갖고 있으면 **AI를 부르지 않고 그 값을 그대로 읽는다**(065, `from-registered.ts`). 등록국이 자기 리콜을 조사해 붙인 값이 우리 추정보다 낫다는 판단이다 |
| 국내 안전관리 연결 | 없음(GPC 코드에서 끝난다) | 브릭까지 확정되면 `lookupDomestic()`으로 국내 `product_taxonomy`를 되짚어 대분류·인증구분·법정 품목까지 이어준다(`domestic.ts`) — 담당자가 실제로 알고 싶은 것은 브릭 번호가 아니라 "이게 어린이제품이고 안전확인 대상인가"이기 때문이다 |

## 5. 우리 코드에서 어디를 보면 되나

| 하는 일 | 파일 |
| --- | --- |
| 벡터 후보 조회 (질의문 포함) | `src/lib/gpc/lookup.ts` |
| 계층 판정 (Brick→Class→Family→Segment) | `src/lib/gpc/verify.ts` |
| 조회+검증 공유 오케스트레이션 | `src/lib/gpc/assign.ts` |
| 신고된 코드 우선 사용 | `src/lib/gpc/from-registered.ts` |
| 위 전부를 잇는 공통 진입점 | `src/lib/gpc/classify.ts` |
| 판정 이력 | `src/lib/gpc/record.ts` · 표 `public.gpc_assignment` |
