/**
 * 절 단위로 묶어 순위를 다시 매긴다 (04 문서 §7.2)
 *
 * 왜 필요한가 — 실측이 말한 것 (2026-09-05)
 *   정답 조항 137건이 왜 안 나왔는지 갈라 보니 이랬다.
 *
 *     적중        38건 (28%)
 *     순위에서 밀림 67건 (49%)   ← 코드도 있고 검색도 되는데 상위 20 밖
 *     검색 불가    18건 (13%)   ← 껍데기라 본문·임베딩이 없다
 *     범위 밖      12건 ( 9%)
 *     미태깅        0건
 *
 *   태깅 누락은 하나도 없었다. 절반은 **순위 문제**다. 후보를 200으로 넓히면 걸린다.
 *
 *   조항 하나하나는 신호가 약해도, 같은 절의 형제 조항이 여럿 걸리면 그 절 전체는
 *   강한 신호다. 15.1 이 50위, 15.1.1 이 80위, 15.2 가 120위라면 개별로는 다 밀리지만
 *   "절 15" 는 세 번 걸린 셈이다. 그 합을 세는 것이 이 파일이 하는 일이다.
 *
 * 껍데기 절도 같이 살아난다
 *   IEC 계열에서 절 자체는 제목만 있는 껍데기다(본문 3자). 코드도 임베딩도 안 붙어
 *   애초에 검색될 수 없었다. 절 단위로 묶으면 하위 조항의 근거가 절의 근거가 되므로
 *   "검색 불가" 18건도 함께 겨냥한다.
 *
 * 계열마다 담당자가 읽는 계위가 다르다 (실측)
 *     전기용품(IEC)     절 단위 69건(64%) · 조항 단위 39건
 *     생활·어린이(부속서) 절 단위  2건( 6%) · 조항 단위 30건(94%)
 *
 *   그래서 묶더라도 하위 조항을 감추지 않는다. 전기용품 담당자는 절 제목을 보고,
 *   생활·어린이 담당자는 그 아래 조항을 본다. 한 구조가 둘을 다 감당한다.
 */

import type { Candidate } from './match';

/** 절 점수를 어떻게 낼 것인가. 어느 쪽이 맞는지는 실측으로 정한다(CLAUDE.md §6) */
export type SectionScoring = 'sum' | 'max' | 'top3';

export interface SectionGroup {
  /** 절 번호. "15.1.1" 의 절은 "15" 다 */
  section: string;
  standardName: string | null;
  score: number;
  /** 이 절에서 걸린 조항들. 점수 순 */
  clauses: Candidate[];
}

/** "15.1.1" → "15" · "2-85" → "2-85" (점이 없으면 그 자체가 절이다) */
export function sectionOf(marker: string): string {
  const i = marker.indexOf('.');
  return i < 0 ? marker : marker.slice(0, i);
}

function scoreOf(clauses: Candidate[], how: SectionScoring): number {
  const scores = clauses.map((c) => c.score).sort((a, b) => b - a);
  if (how === 'max') return scores[0] ?? 0;
  if (how === 'top3') return scores.slice(0, 3).reduce((a, b) => a + b, 0);
  return scores.reduce((a, b) => a + b, 0);
}

/**
 * 후보를 절로 묶어 점수 순으로 돌려준다.
 *
 * 같은 절 번호라도 기준이 다르면 다른 절이다 — KC 60335-1 의 15 와
 * KC 60335-2-23 의 15 는 서로 다른 조항을 가리킨다.
 */
export function groupBySection(
  candidates: Candidate[],
  how: SectionScoring = 'sum',
): SectionGroup[] {
  const byKey = new Map<string, SectionGroup>();

  for (const c of candidates) {
    const section = sectionOf(c.marker);
    const key = `${c.standardName ?? ''}::${section}`;
    let g = byKey.get(key);
    if (!g) {
      g = { section, standardName: c.standardName, score: 0, clauses: [] };
      byKey.set(key, g);
    }
    g.clauses.push(c);
  }

  const groups = [...byKey.values()];
  for (const g of groups) {
    g.clauses.sort((a, b) => b.score - a.score);
    g.score = scoreOf(g.clauses, how);
  }
  return groups.sort((a, b) => b.score - a.score);
}

/**
 * 절 순위대로 조항을 펼쳐 목록을 다시 만든다.
 *
 * 후보 수를 늘리지 않는다. 같은 칸 수를 절 순서로 다시 채울 뿐이다 —
 * 늘리면 재현율이 저절로 오르므로 개선인지 아닌지 알 수 없게 된다.
 */
export function flattenSections(groups: SectionGroup[], limit: number): Candidate[] {
  const out: Candidate[] = [];
  for (const g of groups) {
    for (const c of g.clauses) {
      if (out.length >= limit) return out;
      out.push(c);
    }
  }
  return out;
}
