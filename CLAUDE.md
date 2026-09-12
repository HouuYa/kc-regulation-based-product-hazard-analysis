# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

# 지침 파트 (프로젝트 전용)

위 1~4장은 일반 코딩 지침이다. 이 아래는 **이 저장소에서만 적용되는 규칙**이다.

## 5. 라운드가 끝나면 `구현이력.md` 를 갱신한다

작업 한 라운드(사용자가 지시한 작업 묶음 하나)를 끝낼 때마다, `구현이력.md`
맨 위에 새 항목을 추가한다.

- **쉬운 설명으로 쓴다.** 코드를 안 읽는 사람(협회 담당자 등)도 읽을 수 있어야
  한다. 전문용어는 괄호로 짧게 풀어 쓴다.
- **문단은 한 줄로 쓴다. 마크다운에서 문장을 임의로 끊지 않는다.**
  코드 주석 습관대로 80~90자에서 끊으면 한국어는 조사·어미가 붙어 있어 끊기는
  자리가 어색해지고, 한 낱말만 고쳐도 문단 전체를 다시 접어야 해 diff 가 지저분해진다.
  이 저장소의 기존 문서(README·설계문서·`구현이력.md`)가 이미 한 문단 한 줄이다.
  줄바꿈은 문단·목록·표·코드블록을 나눌 때만 쓴다.
- **"무엇을 했는지"보다 "왜 했는지, 무엇을 확인했는지"를 더 자세히 쓴다.**
  무엇을 했는지는 git 커밋 메시지로 충분하다. 이 문서의 값어치는 나중에
  "그때 왜 이렇게 정했는가"를 되짚을 수 있게 하는 데 있다.
- 기존 항목을 지우거나 고치지 않는다. 계속 쌓아 간다.
- 실측으로 확인한 수치(적재 건수, 검증 결과 등)가 있으면 반드시 남긴다 —
  이 프로젝트는 "구현 전 설계 문서의 가정을 실물로 검증하는" 성격이 커서,
  숫자가 곧 근거가 된다.
- 초안을 쓴 뒤 `.claude/skills/round-log/` 절차로 형식(한 줄 문단·기존 항목
  보존 여부)을 점검한다.
- 문장을 다듬을 때는 `skills/humanize-korean/`을 `구현이력.md` 모드(보수적,
  실측 수치·결정 이유 보존)로 사용한다.
- 파일이 매우 크다(4,000줄 이상). 새 라운드를 넣을 때 **`Write`로 전체를
  다시 쓰지 않는다** — 실수로 과거 기록이 통째로 사라질 수 있다(실제로
  겪었다). 반드시 `Edit`로 맨 위에만 끼워 넣는다.

## 6. 설계문서 버전이 여러 개 공존할 수 있다

이 저장소의 설계문서(`00. 컨셉_...`, `01_사전분석_...v0.6`, `01_보완_...v0.7`,
`제품_위해요인_분류체계_정립_PDR_...`)는 계속 개정된다. v0.6과 v0.7처럼
**서로 다른 버전이 정반대를 말하는 지점**이 생길 수 있다(예: 검색용 텍스트에
LLM 요약을 넣을지 뺄지).

- 어느 한쪽이 맞다고 임의로 판단해 고르지 않는다.
- 실측으로 비교할 수 있는 구조(변형 A/B/C, 환경변수 스위치 등)를 만들어서
  나중에 데이터로 판정한다. 이미 `SEARCH_TEXT_VARIANT`, 태깅 반복 호출 횟수가
  이 방식으로 되어 있다.
- 새 설계문서가 도착하면 이전 버전과 무엇이 다른지, 어느 쪽을 따랐는지를
  커밋 메시지와 `구현이력.md`에 남긴다.
- 새 문서를 만들 때는 §11의 frontmatter `status`/`supersedes`로 이전 버전과의
  관계를 표시한다.

## 7. 자격증명·개인정보

- 실제 키·비밀번호는 `.env.local`에만 둔다. `.env.example`은 값 없는 템플릿만
  커밋 대상이다.
- 새 종류의 민감 파일(원본 PDF, 개인정보 포함 가능 자료 등)을 다루게 되면
  `.gitignore`에 규칙을 추가할지부터 판단한다. 다만 GitHub 웹 UI로 직접 올린
  파일은 로컬 `.gitignore`가 막지 못한다는 점을 기억한다 — 이미 한 번 이렇게
  파일이 원격에 올라간 적이 있다(`구현이력.md` 라운드 4 참조).
- 개인정보 탐지(예: `src/lib/cases/extract-pdf.ts`)는 **완벽한 탐지가 아니라
  안전한 쪽으로 치우친 탐지**가 목표다. 오탐이 생기면 정규식을 헐겁게 풀어서
  놓치는 방향이 아니라, 자릿수·문맥처럼 더 정밀한 조건을 추가해 오탐만 줄이는
  방향으로 고친다.

## 8. 데이터베이스 변경

- 마이그레이션 파일은 `supabase/migrations/`(본 체계)와 `codebook/sql/`
  (코드북)에 번호순으로 쌓는다. 이미 적용된 파일 내용을 고치지 않고 새 번호
  파일을 추가한다.
- `npm run db:push`로 적용한다. Supabase MCP가 연결돼 있으면 MCP로 적용해도
  되지만, 세션 중 MCP 연결이 끊기는 일이 실제로 있었으므로 `DATABASE_URL`
  경로가 항상 동작하는 것을 기본으로 삼는다.
- 새 함수를 만들면 `anon`/`authenticated` 실행 권한이 자동으로 열린다
  (Supabase 기본 동작). 의도한 것이 아니면 반드시 `revoke`한다 —
  실제로 이 실수가 있었고 어드바이저로 발견했다.

## 9. 스크립트·API 라우트 배치 원칙

- 여러 진입점(CLI 스크립트, API 라우트)이 같은 삽입/처리 로직을 쓸 때는
  `src/lib/`에 공유 함수로 뽑는다. 두 곳에 각자 복사해 두면 스키마가 바뀔 때
  한쪽만 고치게 된다(`src/lib/standards/load.ts`가 이 패턴의 예).
- CLI 스크립트는 `scripts/`에, 재사용 가능한 로직은 `src/lib/`에 둔다.
  `scripts/*.ts`는 얇게 유지하고(인자 파싱 + 출력 형식), 실제 로직은
  `src/lib/`에서 가져다 쓴다.

## 10. 제도·법령 해석은 `docs/wiki/개념/법령제도/`를 먼저 본다

법령·제도·행정조치의 뜻을 추측하지 않는다. 담당자가 정리해 둔 원자료가 있다.

- `docs/raw/제품안전법제도/★★★★업무이해 20230405.xlsx` — 「불법제품
  단속」(505행), 「리콜이행 점검」(127행). 불법의 판단 기준, 행정조치(형사고발·
  지자체통보·인증기관통보·판매중지 요청)의 사유, 리콜 이행 절차와 과태료가
  근거 법조문과 함께 들어 있다.
- `docs/raw/제품안전법제도/안전기준목록조사 취합(전기 생활 어린이).xlsx` —
  품목→안전기준 대응 558행(전기용품 446 · 생활용품 75 · 어린이제품 37).
  현재 적재된 것은 76종이고 나머지는 향후 적재 대상이다.

**불량과 불법을 반드시 구분한다.** 이 체계의 산출물이 갈리는 지점이다.

| | 불량 | 불법 |
|---|---|---|
| 무엇 | 안전기준의 기능·성능에 불합격 | 법령이 정한 의무 위반(인증·표시·부품변경 재인증 등) |
| 확인 | 시험을 해야 안다 | 법령을 보면 판정된다 |
| 산출물 | 시험항목 | 인증·표시 확인항목 |

세부 표시사항이 KC안전기준 문서 안에 있더라도, 그것을 지키지 않은 것은 표시 의무
위반이므로 **불법**이다. 시험항목으로 내보내지 않는다. 조항 쪽은
`clause.clause_role`이 `REQUIREMENT`와 `MARKING`으로 이미 나뉘어 있다.

xlsx는 `scripts/build-answer-key.ts`의 방식(zip + XML 직접 파싱)으로 읽는다 —
이 저장소는 파일 몇 개를 읽자고 xlsx 라이브러리를 들이지 않는다.

`docs/raw/`에는 이 두 파일 외에도 업무자료(품목분류·GPC 가이드, 해외 리콜
연동 원자료, 정답지, 실측 대조 결과 등)가 도메인별 폴더로 계속 쌓이고,
`docs/wiki/`에는 그 원자료를 사람이 읽기 좋게 정리한 개념 문서가 쌓인다.
제도·법령·업무 절차·업무 자료 조회는 `.claude/skills/kc-work-reference/`로
절차화되어 있으니 관련 질문에는 이 스킬을 쓴다 — 스킬은 먼저
`docs/wiki/색인.md`에서 관련 개념 문서를 찾고, 없거나 오래됐으면
`docs/raw/`를 직접 본다. 새 업무자료가 `docs/raw/`에 추가되면
`docs/wiki/색인.md`를 함께 갱신하고, 새로운 주제면 개념 문서도 새로 쓴다.

## 11. 새 `.md` 문서에는 표준 frontmatter를 붙인다

새로 만드는 `docs/*.md`, 루트 설계문서(`00.`~`04-*`), `codebook/*.md` 등
업무 문서에는 맨 위에 아래 frontmatter를 붙인다. 기존 문서에는 소급 적용하지
않는다 — §3(외과적 변경) 원칙대로 손대지 않는다. `구현이력.md`(append-only
이력)와 `skills/*/SKILL.md`(Claude 스킬 자체 frontmatter 규격을 따름)는
이 규칙 대상이 아니다.

```yaml
---
created: YYYY-MM-DD      # 생성일자 (필수)
updated: YYYY-MM-DD      # 마지막 업데이트일자 (필수, 문서를 고칠 때마다 최신화)
description: 이 문서가 무엇을 다루는지 한 줄 (필수)
status: draft | active | superseded | deprecated   # 문서 상태 (선택)
supersedes: []             # 이 문서가 대체하는 이전 문서 파일명 (있으면)
related: []                 # 함께 참고해야 할 문서 파일명 (있으면)
---
```

`status`/`supersedes`는 §6과 바로 연결된다 — 새 버전이 나오면 이전 문서에
`status: superseded`를 달고, 새 문서의 `supersedes`에 이전 파일명을 적는다.

`docs/wiki/`의 개념 문서는 `sources: []`를 추가로 붙인다 — 그 문서가
종합한 `docs/raw/...` 원자료 경로 목록이다. 원자료가 없는 설계문서(루트
`00.`~`04-*`, `codebook/*.md`)는 이 칸을 생략한다.

## 12. `site/` 소개페이지도 주요 변경 시 함께 갱신한다

`site/index.html`은 GitHub Pages로 나가는 정적 소개페이지다(구현이력.md
라운드 63). README.md와 마찬가지로 이 저장소 바깥의 사람(협회 담당자 등)이
보는 창구이므로, README.md·설계문서를 고칠 만큼 **주요한 변경**이 있으면
이 페이지도 함께 갱신한다.

- **무엇이 "주요 변경"인가** — 계기판 수치(적재 안전기준·조항·해외 리콜·
  사고조사보고서 건수), 여섯 걸음 흐름의 진행 상태, 다섯 병목의 처리율,
  산출물 상태(`동작 확인`/`화면 미완`/`아직 비어 있음` 등)가 실제로
  달라졌을 때, 또는 README.md의 기능 설명이나 mermaid 흐름도를 고칠
  정도로 체계 자체가 바뀌었을 때다. 구현이력.md에 라운드를 기록할 정도의
  라운드라고 해서 전부 대상은 아니다 — 이 페이지가 보여주는 수치·표에
  실제로 영향이 있을 때만 고친다.
- **어디를 고치나** — 8개 탭(무엇을 하나·일이 도는 순서·지금 막힌 곳·
  산출물·가르는 기준·분류 두 축·법적 근거·이번 분기) 중 실제로 바뀐 탭만
  고치고, masthead의 `기준일`을 갱신 시점 날짜로 함께 바꾼다.
- **수치는 실측만 넣는다** — 이 페이지는 DB에 직접 연결된 화면이 아니라
  정적 스냅샷이므로, 반영 전에 실제 쿼리·화면으로 확인한 값만 적는다.
  §5(구현이력)와 같은 원칙이다.
- 이 페이지는 GitHub Pages로 공개된다(비공개 저장소여도 URL을 아는 누구나
  접근 가능 — 라운드 63 참고). 내부에서만 통용되는 표현이나 민감한 수치를
  옮기기 전에, 공개해도 되는 내용인지 한 번 더 판단한다.
- 라운드를 마칠 때 §5의 구현이력 갱신과 같은 자리에서 "이 라운드가 이
  페이지에 반영할 만한가"도 함께 판단한다.

## 13. 사고보고서의 결론을 그대로 믿지 않는다 — 병행 점검 계층 (라운드 70)

담당자가 이 원칙을 직접 정했다: "사고보고서의 내용을 그대로 믿지 말고 별도로
심층 분석해야 한다." 올라온 보고서는 전부 사람이 검수해 종결한 건이지만, 그
결론은 **확인해야 할 주장**이지 복사해 올 정답이 아니다. "적합"은 보고서가
**시험한 범위 안에서만** 적합이다 — 사건 5614(전기주전자)는 유리 본체가
파열됐는데 기계적 강도·열 충격 두 가지만 시험하고 "충족"으로 끝났고, 사건
5607(온열기구류)은 56.6℃로 "적합"인데 피해자는 2·3도 화상을 입었다(저온화상,
기준 문턱값이 못 잡는 위해).

이 원칙을 구현한 것이 `src/lib/second-opinion/`의 병행 점검 계층이다 —
보고서가 스스로 적은 "무슨 시험을 했는가"와 그 품목에 적용되는 안전기준
전체를 견주어 "시험하지 않은 구간"을 찾고, 국내외 리콜 교차 근거를 함께
낸다. 자세한 설계·실측·판정 기준은 `구현이력.md` 라운드 70을 본다.

**지키는 선 넷 — 이 계층을 건드리는 작업은 반드시 지킨다.**

1. `case_tag`(확정 태그)에 쓰지 않는다. 추정 코드는 `second_opinion_finding`에만
   산다. `HF.UNKNOWN`은 "조사가 원인을 밝히지 못했다"는 사실의 기록이고, 추정으로
   덮으면 그 사실 자체가 데이터에서 사라진다.
2. 기본 조항 검색(`match_run`/`match_result`)을 덮어쓰지 않는다. 원인 통계를
   기본 검색에 자동 반영했더니 재현율이 떨어진 실측이 있다(04-1 §8) — 화면에서도
   병행 점검 소견은 기본 목록 **아래**에 별도 구역으로 둔다.
3. 불량(시험항목, `output_kind='TEST_ITEM'`)과 불법(인증·표시 확인항목,
   `CERT_MARKING_CHECK`)을 표 구조로 가른다(§10과 같은 구분).
4. 원문에 없는 것을 추출하지 않는다. `evidence_span`을 저장 직전 원문
   부분문자열로 코드가 다시 검사한다 — 통과 못 한 것은 버리고 개수를 남긴다.
   다만 "인용 한 구절이 정확히 같은가"로 너무 세게 걸면 실행마다 흔들려 조사관이
   실제로 한 일을 "안 했다"고 말하는 **더 위험한 거짓**을 만든다(라운드 70에서
   실측으로 잡음) — 검사 기준을 좁힐 때는 이 반대급부를 먼저 재본다.

새 도메인의 원문 대조 로직(예: 조항 제목 ↔ 보고서 시험명 매칭)을 만들 때는
`src/lib/standards/title-match.ts`를 재사용한다. 이 파일 자체가 "같은 로직을
두 곳에 복사해 두면 한쪽만 고치게 된다"(§9)는 원칙 때문에 `scripts/link-test-methods.ts`에서
공유 자리로 옮겨진 것이다.

「동일성확인」이 왜 AI 추정이 아니라 인증기관의 유권해석인지는
`docs/wiki/개념/법령제도/동일성확인_인증기관_유권해석.md`를 함께 본다.

## 14. 운영 습관 세 가지

- 새 LLM 호출을 추가하면 `src/lib/llm/catalog.ts`의 `CALL_SITES`에도
  등록한다 — 안 하면 `/llm` 화면과 문서가 코드와 어긋난다.
- 여러 건에 자동으로 도는 배치 스크립트는 `--case <id>` 하나로 먼저
  확인한 뒤 `--all`로 간다.
- 확인용으로 띄운 개발 서버(`next dev`)를 끝낼 때 `netstat`으로 포트가
  실제로 풀렸는지 본다 — 종료 도구가 "됐다"고 해도 프로세스가 남는 일이
  실제로 있었다.

## 15. 응답은 쉬운 말 요약으로 마무리한다

작업을 마치면 코드를 모르는 사람(협회 담당자 등)도 알아볼 수 있는 말로
"무엇을 했고 다음에 뭘 하면 되는지"를 짧게 정리해 끝맺는다. §5가
`구현이력.md`에 요구하는 것과 같은 원칙을 대화 응답에도 적용한다.
