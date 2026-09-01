/**
 * 검색용 텍스트 조립 (설계문서 결정항목 9)
 *
 * "하이브리드 품질의 8할이 여기서 결정됨. 0단계에서 2~3개 안을 만들어 비교."
 *
 * 왜 변형을 여러 개 두는가 — 두 문서가 정반대를 말하기 때문이다.
 *
 *   v0.6 §5.2.4  조각 앞에 상위 맥락을 결합하고, 코드북 분류명과 LLM 한 줄 요약도
 *                머리말에 넣어 임베딩·키워드 색인을 함께 만든다.
 *                근거: Anthropic 실험에서 맥락 결합 시 검색 실패율 5.7%→2.9%.
 *
 *   v0.7 §7.4    코드분류명과 LLM 요약을 기본 머리말에 섞지 마라.
 *                근거: 같은 LLM 호출에서 만든 코드·키워드·요약을 세 갈래에 모두
 *                쓰면 하나의 잘못된 해석이 세 갈래에 반복되어 RRF 가 오류를
 *                증폭한다(신호 독립성 훼손).
 *
 * 둘 다 일리가 있고 우리 데이터로 재 보기 전에는 어느 쪽이 맞는지 알 수 없다.
 * 그래서 고르지 않고 변형으로 만든다. SEARCH_TEXT_VARIANT 로 전환하고
 * §5.8 비교표에서 판정한다. 임베딩은 재생성이 가장 싼 산출물이므로(§3.4)
 * 이 실험의 비용도 가장 낮다.
 */

export type SearchTextVariant = 'A' | 'B' | 'C';

export interface ClauseTextInput {
  /** 품목명 — 예: 유아용 의자 */
  itemName: string | null;
  /** 인증구분·부속서 등 기준 식별 — 예: 안전확인 부속서 8 */
  standardLabel: string | null;
  /** 계위 경로 — 예: 제1부 > 4 > 4.3 > 4.3.3 */
  breadcrumbPath: string | null;
  /** 조항유형 — 성능요건/시험방법 등. v0.7 §5.3 이 검색 대상 구분에 쓴다 */
  clauseType?: string | null;
  marker: string;
  body: string;
  /** LLM 이 만든 한 줄 요약 (L1 태깅 산출물) */
  chunkSummary?: string | null;
  /** 코드북 분류명 — 예: 설계결함 / 낙상·전도 */
  codeLabels?: string[];
  /** 검증된 시험조건 요약 — 예: 150 N 수직 하중 */
  testConditions?: string[];
}

function line(label: string, value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v ? `${label}: ${v}` : null;
}

/**
 * 변형 A — v0.6 §5.2.4 그대로.
 * 머리말에 품목·계위·코드북 분류명을 넣고 한 줄 요약을 본문 앞에 둔다.
 */
function variantA(c: ClauseTextInput): string {
  const parts = [
    line('품목', [c.itemName, c.standardLabel ? `(${c.standardLabel})` : null].filter(Boolean).join(' ')),
    line('위치', c.breadcrumbPath),
    line('분류', (c.codeLabels ?? []).join(' / ')),
    line('요약', c.chunkSummary),
    c.body,
    (c.testConditions ?? []).length ? `시험조건: ${(c.testConditions ?? []).join('; ')}` : null,
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * 변형 B — v0.7 §7.4 권고 기본형.
 * 사실로 확인 가능한 메타데이터만 머리말에 두고, LLM 생성물(요약·분류명)은 뺀다.
 * 시험조건은 검증된 값이므로 남긴다.
 */
function variantB(c: ClauseTextInput): string {
  const parts = [
    line('품목', c.itemName),
    line('기준', c.standardLabel),
    line('위치', c.breadcrumbPath),
    line('조항유형', c.clauseType),
    c.body,
    (c.testConditions ?? []).length ? `시험조건: ${(c.testConditions ?? []).join('; ')}` : null,
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * 변형 C — 기준선. 원문만.
 * 맥락 결합이 실제로 효과가 있는지 재려면 결합하지 않은 대조군이 있어야 한다.
 */
function variantC(c: ClauseTextInput): string {
  return c.body;
}

export function buildClauseSearchText(
  c: ClauseTextInput,
  variant: SearchTextVariant = 'A',
): string {
  switch (variant) {
    case 'A': return variantA(c);
    case 'B': return variantB(c);
    case 'C': return variantC(c);
  }
}

/**
 * 사건(사고·리콜)의 검색용 텍스트.
 *
 * 조항과 같은 조립 규칙을 쓰는 것이 중요하다. 양쪽 표현 층위가 어긋나면
 * 벡터 거리가 멀어진다 — §5.2.1 이 한 줄 요약을 만드는 이유가 바로 그것이다.
 */
export function buildCaseSearchText(
  input: {
    itemName: string | null;
    title: string | null;
    narrative: string;
    chunkSummary?: string | null;
    codeLabels?: string[];
  },
  variant: SearchTextVariant = 'A',
): string {
  const parts =
    variant === 'C'
      ? [input.narrative]
      : [
          line('품목', input.itemName),
          line('제목', input.title),
          variant === 'A' ? line('분류', (input.codeLabels ?? []).join(' / ')) : null,
          variant === 'A' ? line('요약', input.chunkSummary) : null,
          input.narrative,
        ];
  return parts.filter(Boolean).join('\n');
}

/** 조항 머리말만 따로 — clause.context_header 에 저장한다 */
export function buildContextHeader(c: ClauseTextInput): string {
  return [
    line('품목', [c.itemName, c.standardLabel ? `(${c.standardLabel})` : null].filter(Boolean).join(' ')),
    line('위치', c.breadcrumbPath),
    line('분류', (c.codeLabels ?? []).join(' / ')),
  ]
    .filter(Boolean)
    .join('\n');
}
