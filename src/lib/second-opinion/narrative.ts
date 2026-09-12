/**
 * 사고조사보고서 원문에서 읽을 구역을 찾는다 (LLM 없음)
 *
 * 이 파일이 하지 않는 일
 *   문장의 뜻을 판정하지 않는다. 찾아서 잘라 주기만 한다.
 *
 *   라운드 69 가 정규식만으로 「동일성.{0,30}(불가|불일치|상이)」 를 세다가
 *   "식별 불가능한 부품을 제외하고 인증당시와 부품이 동일함" 을 상이로 뒤집어
 *   세었다. 40건이라 보고했다가 재검증 후 18건으로 정정한 것이 이 실수다.
 *   낱말이 있다는 것과 그 문장이 그 뜻이라는 것은 다르다 — 뜻은 extract.ts 가
 *   LLM 으로 읽는다.
 *
 * 왜 원문 전체를 주지 않는가
 *   사고조사보고서는 목차·시험절차·참고자료가 뒤섞인 8,000자 안팎의 문서다.
 *   실측 최대 8,808자. 그중 우리가 읽을 구역은 1/4 도 안 된다. 전체를 주면
 *   값도 비싸지고 모델이 시험절차 표 안에서 헤맨다.
 *
 * 구역을 실제로 찾을 수 있는가 (2026-09-11 사고보고서 71건 전량 실측)
 *   「조사 방법」 줄이 70건(99%), 동일성 확인 절이 64건(90%) 에 있다.
 *   표기도 일관적이다 — "조사 방법 :", "조사 방법:", "조사방법:" 세 가지뿐이고
 *   내용은 "현장 조사, 동일성 확인, 제품시험(온도상승, 이상운전)" 꼴이다.
 *
 *   다만 PDF 에서 뽑은 글이라 줄이 문장 한복판에서 끊긴다. 실측 예:
 *     "조사 방법 : 동일성 확인, 안전기준시험(과충전시험, 외부단락 시험, 전지에 공급되는"
 *   그래서 찾은 자리에서 한 줄만 떼지 않고 뒤쪽을 넉넉히 함께 자른다.
 */

export type SectionKind =
  | 'METHOD'      // 조사 방법 — 수행한 시험 목록이 여기 있다
  | 'IDENTITY'    // 동일성 확인 — 인증 당시 제품과 같은가
  | 'RESULT'      // 결함조사·시험 결과
  | 'CONCLUSION'  // 결론
  | 'MARKING'     // 표시사항
  | 'NON_TARGET'; // (비대상) — 적용할 안전기준이 없다

export interface Section {
  kind: SectionKind;
  /** narrative 안의 시작 위치 */
  start: number;
  end: number;
  text: string;
}

/**
 * 구역마다 어디를 기준으로 얼마를 자를 것인가.
 *
 * before 를 두는 이유는 "3. 조사 확인 내용" 같은 머리말이 앞줄에 있어서다.
 * after 가 넉넉한 이유는 위 주석의 줄 끊김 때문이다.
 */
const ANCHORS: Array<{
  kind: SectionKind;
  re: RegExp;
  before: number;
  after: number;
  /** 같은 종류를 몇 군데까지 담을 것인가. 목차·본문에 같은 말이 여러 번 나온다 */
  max: number;
}> = [
  { kind: 'METHOD',     re: /조사\s?방법/g,                                    before: 120, after: 400, max: 3 },
  { kind: 'IDENTITY',   re: /동일성\s?확인\s?결과|동일성\s?확인|동일성/g,        before: 80,  after: 500, max: 4 },
  { kind: 'RESULT',     re: /원인의?\s?분석\s?결과|결함조사\s?결과|시험\s?결과/g, before: 80,  after: 600, max: 4 },
  { kind: 'CONCLUSION', re: /결\s?론/g,                                        before: 40,  after: 500, max: 2 },
  { kind: 'MARKING',    re: /표시\s?사항|표시\s?요구사항|미표시/g,               before: 120, after: 400, max: 3 },
  { kind: 'NON_TARGET', re: /비대상/g,                                         before: 80,  after: 200, max: 2 },
];

/**
 * 잘라 낸 구역이 아무리 많아도 이만큼까지만 LLM 에 준다.
 *
 * 6,000자면 최악의 경우에도 원문 전체(8,808자)보다 3할 가까이 적고, 실측상
 * 대부분의 보고서는 이 값에 닿지도 않는다. 닿는 보고서는 같은 말이 목차·본문·
 * 요약에 반복되는 경우라, 잘려 나가는 쪽은 대개 중복이다.
 */
const MAX_SLICE = 6000;

export function locateSections(narrative: string): Section[] {
  const found: Section[] = [];

  for (const a of ANCHORS) {
    const re = new RegExp(a.re.source, 'g');
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(narrative)) !== null && n < a.max) {
      const start = Math.max(0, m.index - a.before);
      const end = Math.min(narrative.length, m.index + m[0].length + a.after);
      found.push({ kind: a.kind, start, end, text: narrative.slice(start, end) });
      n++;
      // 창이 겹치도록 다시 훑지 않는다 — 같은 자리를 몇 번씩 담게 된다
      re.lastIndex = end;
    }
  }

  return found.sort((x, y) => x.start - y.start);
}

/**
 * LLM 에 줄 축약본.
 *
 * 겹치는 창은 합친다. 합치지 않으면 같은 문장이 두 번 들어가고, 그러면 모델이
 * 같은 시험을 두 건으로 세는 일이 생긴다.
 *
 * 자른 자리에 「…」 를 넣는 이유 — 모델이 두 구역을 이어진 한 문장으로 읽고
 * 원문에 없는 문장을 인용해 버리면 span 검사에서 통째로 버려진다. 끊겼다는 것을
 * 보여 주는 편이 싸다.
 */
export function sliceForExtraction(narrative: string): string {
  const sections = locateSections(narrative);
  if (sections.length === 0) {
    // 구역을 못 찾았다. 앞부분이라도 준다 — 사고보고서는 첫 장에 요약이 있다
    return narrative.slice(0, MAX_SLICE);
  }

  const merged: Array<{ start: number; end: number }> = [];
  for (const s of sections) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ start: s.start, end: s.end });
    }
  }

  let out = '';
  for (const r of merged) {
    if (out.length >= MAX_SLICE) break;
    const piece = narrative.slice(r.start, r.end);
    out += (out ? '\n…\n' : '') + piece.slice(0, MAX_SLICE - out.length);
  }
  return out;
}

/** 어느 종류의 구역을 찾았는지 — run 기록과 화면 설명에 쓴다 */
export function sectionKinds(narrative: string): SectionKind[] {
  return [...new Set(locateSections(narrative).map((s) => s.kind))];
}

/**
 * 공백을 하나로 눌러 맞춘다.
 *
 * PDF 에서 뽑은 원문은 줄바꿈이 문장 한복판에 들어 있는데, 모델은 인용할 때
 * 그것을 띄어쓰기로 바꿔 적는다. 글자 그대로 비교하면 멀쩡한 인용이 전부 탈락한다.
 */
function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 인용이 원문에 실제로 있는가 — 이 계층의 유일한 집행 장치다.
 *
 * 스키마의 required 와 프롬프트의 "그대로 인용하라"는 모델의 협조에 기대는 것이고,
 * 기계가 판정하는 것은 이 함수뿐이다. 통과 못 한 항목은 버리고 개수를
 * second_opinion_run.dropped_span_count 에 남긴다 — 버린 개수 자체가 품질 지표다.
 */
export function verifySpan(narrative: string, span: string): boolean {
  const s = flatten(span);
  // 너무 짧은 인용은 우연히 걸린다. "적합" 두 글자는 어느 보고서에나 있다
  if (s.length < 6) return false;
  return flatten(narrative).includes(s);
}
