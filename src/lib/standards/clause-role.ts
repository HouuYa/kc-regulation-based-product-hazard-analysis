/**
 * 조항 역할 분류 (v0.7 §5.3 "조항 유형과 관계")
 *
 * v0.7 이 명시한 표를 그대로 옮긴 것이다.
 *
 *   적용범위·정의   직접 후보 제외 — 품목 범위·용어 해석에만 사용
 *   성능요건        주 검색 대상 — 위해요인과 대조한다
 *   시험방법        원칙적으로 관계 확장 — 연결된 성능요건에서 이동해 온다
 *   시험조건·표·그림 직접 후보 제외 — 시험방법의 상세 근거로 제공
 *   표시·주의사항   트랙별 선택 — 사고원인이 경고·표시와 관련될 때만
 *   부록·참고       기본 제외 — 담당자 선택 시 표시
 *
 * 왜 필요한가 (실측으로 확인한 문제)
 *   역할 구분 없이 태깅했더니 "가량이 벨트란 유아가 미끄러져 나오지 못하게 하는
 *   장치를 말한다"(용어의 정의)에 HF.M.DES + DT.MECHANICAL.FALL 이 일치도 1.0 으로
 *   붙었다. 정의문은 무엇도 요구하지 않으므로 시험 후보가 될 수 없는데,
 *   코드가 붙으면 진짜 안전요건 조항과 같은 자격으로 검색에 걸린다.
 *   §5.8 정확도를 재기 전에 이 오염을 막아야 측정이 의미를 갖는다.
 *
 * 부수 효과로 비용도 준다 — 정의·적용범위는 전체 조항의 상당 부분이고,
 * 태깅하지 않으면 그만큼 LLM 호출이 사라진다.
 */

export type ClauseRole =
  /** 성능요건 — 주 검색 대상 */
  | 'REQUIREMENT'
  /** 시험방법 — 관계 확장으로 도달 */
  | 'TEST_METHOD'
  /** 적용범위 */
  | 'SCOPE'
  /** 인용·관련 표준 */
  | 'REFERENCE'
  /** 용어의 정의 */
  | 'DEFINITION'
  /** 표시·주의사항 */
  | 'MARKING'
  /** 부록·참고 */
  | 'ANNEX'
  /** 표·그림·비고 등 본문이 아닌 조각 */
  | 'FRAGMENT'
  /** 판정 불가 */
  | 'OTHER';

/**
 * 최상위 절 제목으로 판정한다.
 *
 * 조항 하나만 보고는 알 수 없다. "3.3 가량이 벨트 …를 말한다"는 그 자체로는
 * 애매하지만, 속한 절이 "3 용어의 정의"라면 확실히 정의다. 그래서 계위의
 * 뿌리를 보고 그 아래 전체에 같은 역할을 물려준다.
 *
 * 제목 목록은 76개 기준 실물에서 뽑은 빈도 상위 항목을 근거로 했다
 * (적용범위 96, 시험방법 46, 안전요건 37, 검사방법 35, 용어의 정의 48, 인용표준 24 …).
 */
export function classifyRootTitle(rawTitle: string | null | undefined): ClauseRole {
  const t = (rawTitle ?? '').replace(/\s+/g, '');
  if (!t) return 'OTHER';

  // 순서가 곧 우선순위다. "시험에 관한 일반 조건"이 '조건'보다 '시험'으로 먼저 걸려야 한다.
  if (/^적용범위|^적용대상/.test(t)) return 'SCOPE';
  if (/^인용표준|^관련표준|^참고문헌|^인용규격/.test(t)) return 'REFERENCE';
  if (/^용어(의|와)?정의|^정의$/.test(t)) return 'DEFINITION';
  if (/시험방법|검사방법|^시험에관한|^시험$|^검사$/.test(t)) return 'TEST_METHOD';
  // "표시 및 사용설명서"(IEC 60335 제7절 Marking and instructions)처럼 묶인 제목이
  // 실제 기준에 더 많다. 이 형태를 빼 두었더니 같은 성격의 절이 기준마다 다르게
  // 분류됐다 — "표시사항"은 MARKING 28건, "표시 및 사용설명서"는 REQUIREMENT 14건.
  if (/^표시사항|^표시$|^표시및|^사용설명서|^경고문|^주의사항/.test(t)) return 'MARKING';
  if (/^부록|^부속서|^별표|^참고$/.test(t)) return 'ANNEX';
  if (/^공란$|^서문|^머리말/.test(t)) return 'OTHER';

  // 나머지는 요건으로 본다. 기계적 강도·온도 상승·내부식성·이상 운전·구조 같은
  // 절들이 여기 해당하며, 이들이 실제 검색 대상이다.
  return 'REQUIREMENT';
}

/** 파싱 단계의 level_code 로 본문이 아닌 조각을 먼저 걸러낸다 */
const FRAGMENT_LEVELS = new Set(['LT', 'LF', 'LN']);

export function classifyClause(input: {
  levelCode: string | null;
  /** 이 조항이 속한 최상위 절의 제목 */
  rootTitle: string | null;
}): ClauseRole {
  if (input.levelCode && FRAGMENT_LEVELS.has(input.levelCode)) return 'FRAGMENT';
  return classifyRootTitle(input.rootTitle);
}

/**
 * 태깅 대상인가.
 *
 * 요건만 태깅한다. 시험방법은 clause_link 로 도달하므로 코드를 붙일 필요가 없고,
 * 정의·적용범위는 후보가 되면 안 된다.
 *
 * 표시사항은 트랙별 선택이라 기본 제외로 둔다 — 사고 원인이 경고·표시와 관련될 때
 * 별도 후보로 켜는 것이 v0.7 §5.3 의 지시다. 지금 켜면 그 구분이 사라진다.
 *
 * 다만 그 "켜는" 쪽은 아직 만들지 않았다. 지금은 표시 조항 879건이 어떤 사건에서도
 * 후보가 되지 않는다. 화상·질식처럼 경고 표시가 실제 확인 항목이 되는 사고가 있으므로,
 * 조건부로 켜는 장치가 다음 과제로 남아 있다.
 */
export function shouldTag(role: ClauseRole): boolean {
  return role === 'REQUIREMENT';
}
