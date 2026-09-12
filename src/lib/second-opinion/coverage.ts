/**
 * 시험 범위 공백 — "적합은 시험한 범위 안에서만 적합이다"
 *
 * 분모  그 품목에 적용되는 안전기준의 성능요건(REQUIREMENT) 전체
 * 분자  보고서가 수행했다고 스스로 적은 시험
 * 공백  분모 − 분자 중, 이 사고의 피해유형·원인후보와 닿는 것
 *
 * 분모를 여기서 새로 정의하지 않는다
 *   standardsForCase() 가 유일한 경로다. 거기 말고 다른 곳에서 "적용되는 기준"을
 *   정하면 화면·검색·병행점검이 서로 다른 분모를 쓰게 되고, 그러면 담당자가 보는
 *   "47개 중 6개" 의 47이 화면마다 달라진다.
 *
 * 가장 조용히 틀릴 수 있는 자리 (위험 1)
 *   보고서는 "기계적 강도" 라 쓰고 기준은 "5.3 기계적 강도 시험" 또는 아예 "충격"
 *   이라 쓴다. 매핑에 실패하면 분자가 0이 되어 **"전부 공백"이라는 가장 위험한
 *   거짓 산출물**이 나온다. 참인 문장이지만 쓸모가 없고, 담당자는 목록을 버린다.
 *
 *   그래서 못 맞힌 시험을 공백으로 세지 않고 UNMAPPED 로 따로 센다. 화면도
 *   "우리가 못 맞힌 시험 3건" 을 반드시 함께 보인다 — 분자가 비었다는 사실을
 *   감추면 공백 목록을 믿을 수 없다.
 */

import { getDb } from '../db';
import { sectionOf } from '../search/group-section';
import { normTitle, spacelessMatch, STOP_TITLES } from '../standards/title-match';
import { matchableTestName, splitClauseMarker } from './extract';

export interface ApplicableClause {
  id: number;
  standardId: number;
  standardName: string | null;
  marker: string;
  part: string | null;
  title: string;
  role: string;
}

export interface SectionKey {
  standardId: number;
  standardName: string | null;
  part: string | null;
  section: string;
  title: string;
  clauseIds: number[];
}

/**
 * 적용 조항을 성능요건과 표시로 갈라 읽는다.
 *
 * 표시(MARKING)를 함께 읽는 이유 — 시험항목에 섞지 않기 위해서다(CLAUDE.md §10).
 * 갈라 두면 ②(불법 신호)가 쓸 출구가 되고, 섞어 두면 걸러 낼 방법이 없다.
 */
export async function loadApplicableClauses(
  standardIds: number[],
): Promise<{ requirement: ApplicableClause[]; marking: ApplicableClause[] }> {
  if (standardIds.length === 0) return { requirement: [], marking: [] };

  const rows = await getDb()<{
    id: string; standard_id: string; standard_name: string | null;
    marker: string; part: string | null; title: string; role: string;
  }[]>`
    select c.id, c.standard_id, s.display_name as standard_name,
           c.marker, c.part, coalesce(c.title_raw, '') as title, c.clause_role as role
    from public.clause c
    join public.standard s on s.id = c.standard_id
    where c.standard_id = any(${standardIds})
      and c.clause_role in ('REQUIREMENT', 'MARKING')
  `;

  const map = (r: (typeof rows)[number]): ApplicableClause => ({
    id: Number(r.id),
    standardId: Number(r.standard_id),
    standardName: r.standard_name,
    marker: r.marker,
    part: r.part,
    title: r.title,
    role: r.role,
  });

  return {
    requirement: rows.filter((r) => r.role === 'REQUIREMENT').map(map),
    marking: rows.filter((r) => r.role === 'MARKING').map(map),
  };
}

/** 같은 절 번호라도 기준·부(part)가 다르면 다른 절이다 */
function keyOf(c: ApplicableClause): string {
  return `${c.standardId}|${c.part ?? ''}|${sectionOf(c.marker)}`;
}

/**
 * 조항을 절로 묶는다.
 *
 * part 를 키에 넣는 이유 — 넣지 않으면 KC 60335-1 본문의 "11 온도 상승" 과
 * 부속서 E 의 같은 번호가 한 절로 뭉친다(group-section.ts 와 같은 규칙).
 */
export function groupSections(clauses: ApplicableClause[]): Map<string, SectionKey> {
  const out = new Map<string, SectionKey>();
  // 절 제목은 최상위 조항(점이 없는 marker)의 제목이다
  const rootTitle = new Map<string, string>();
  for (const c of clauses) {
    if (!c.marker.includes('.')) rootTitle.set(keyOf(c), c.title);
  }

  for (const c of clauses) {
    const k = keyOf(c);
    let g = out.get(k);
    if (!g) {
      g = {
        standardId: c.standardId,
        standardName: c.standardName,
        part: c.part,
        section: sectionOf(c.marker),
        title: rootTitle.get(k) ?? c.title,
        clauseIds: [],
      };
      out.set(k, g);
    }
    g.clauseIds.push(c.id);
  }
  return out;
}

export interface TestMatch {
  /** 보고서에 적힌 시험명 그대로 */
  name: string;
  normalized: string;
  /** 맞힌 조항들 */
  clauseIds: number[];
  /** 맞힌 절 키 */
  sectionKeys: string[];
  mapped: boolean;
}

/**
 * 보고서가 적은 시험명을 조항 제목에 맞춘다.
 *
 * 1단계는 제목 접두 일치만 쓴다 — scripts/link-test-methods.ts 가 요건과 시험을
 * 잇는 데 쓰는 바로 그 규칙이다. 좁게 잡는 쪽을 고른 이유는 그 파일 주석과 같다:
 * 틀린 연결은 없는 연결보다 나쁘다.
 *
 * 임베딩 매핑은 넣지 않았다. UNMAPPED 비율을 먼저 실측하고, 30%를 넘을 때만
 * 2단계에서 clause.embedding 을 재사용해 넣는다 — 넘지 않으면 넣지 않는다.
 */
export function matchPerformedTests(
  testNames: string[],
  clauses: ApplicableClause[],
): TestMatch[] {
  return testNames.map((name) => {
    const { marker } = splitClauseMarker(name);
    const n = matchableTestName(name);
    const clauseIds: number[] = [];
    const sectionKeys = new Set<string>();

    /*
      보고서가 조항 번호를 인용했으면 그것을 먼저 쓴다.

      「4.1 유해원소 용출 시험」의 4.1 은 제목보다 정확한 지시자다. 하위 조항까지
      함께 잡는 이유는 보고서가 「4.1」이라 적었을 때 4.1.1·4.1.2 도 그 시험에
      들어가기 때문이다.
    */
    if (marker) {
      for (const c of clauses) {
        if (c.marker === marker || c.marker.startsWith(`${marker}.`)) {
          clauseIds.push(c.id);
          sectionKeys.add(keyOf(c));
        }
      }
    }

    if (n && !STOP_TITLES.has(n)) {
      for (const c of clauses) {
        const ct = normTitle(c.title);
        if (!ct || STOP_TITLES.has(ct)) continue;
        if (!spacelessMatch(n, ct)) continue;
        if (!clauseIds.includes(c.id)) clauseIds.push(c.id);
        sectionKeys.add(keyOf(c));
      }
    }

    return {
      name,
      normalized: n,
      clauseIds,
      sectionKeys: [...sectionKeys],
      mapped: clauseIds.length > 0,
    };
  });
}

export interface GapSection extends SectionKey {
  /** 이 절 아래 조항에 붙은 코드 — 관련성 판단 재료 */
  hfCodes: string[];
  dtCodes: string[];
  /** 이 사건의 코드를 실제로 단 조항이 이 절에 몇 개인가 */
  hitClauses: number;
  /** 조항 하나당 평균 무게 — 순위를 매기는 값 (04-1 의 신뢰도에 해당) */
  density: number;
  /** 절 안에서의 밀도 ÷ 적용 기준 전체에서의 밀도. 1 이하면 후보가 아니다 */
  lift: number;
  relatedBy: string[];
  /** 이 절의 요건을 확인할 시험방법 조항 (clause_link 를 따라간 결과) */
  testMethodClauseId: number | null;
}

/**
 * 절 아래 조항에 붙은 HF/DT 코드를 읽는다.
 *
 * rejected 된 태그는 빼고 읽는다 — 담당자가 아니라고 판정한 코드를 근거로
 * 공백을 제안하면 같은 판단을 두 번 뒤집는 셈이 된다.
 */
async function codesByClause(clauseIds: number[]): Promise<Map<number, { hf: string[]; dt: string[] }>> {
  const out = new Map<number, { hf: string[]; dt: string[] }>();
  if (clauseIds.length === 0) return out;

  const rows = await getDb()<{ clause_id: string; axis: string; code: string }[]>`
    select clause_id, axis, code
    from public.clause_tag
    where clause_id = any(${clauseIds}) and review_status <> 'rejected'
  `;
  for (const r of rows) {
    const id = Number(r.clause_id);
    const e = out.get(id) ?? { hf: [], dt: [] };
    if (r.axis === 'HF') e.hf.push(r.code);
    else e.dt.push(r.code);
    out.set(id, e);
  }
  return out;
}

/** 절의 요건을 확인할 시험방법 조항을 찾는다 — "그래서 무슨 시험을 의뢰하나"의 답 */
async function testMethodFor(clauseIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (clauseIds.length === 0) return out;
  const rows = await getDb()<{ from_clause_id: string; to_clause_id: string }[]>`
    select from_clause_id, to_clause_id
    from public.clause_link
    where link_type = 'TEST_METHOD'
      and to_clause_id is not null
      and from_clause_id = any(${clauseIds})
  `;
  for (const r of rows) {
    if (!out.has(Number(r.from_clause_id))) out.set(Number(r.from_clause_id), Number(r.to_clause_id));
  }
  return out;
}

/**
 * 얇은 절 보정. 밀도를 낼 때 분모에 더한다.
 *
 * 5 인 것은 cause-bridge.ts 의 MIN_SUPPORT 와 같은 값이고 같은 취지다 — 근거가
 * 이보다 얇으면 우연일 수 있다. 다만 그쪽처럼 잘라 내지 않고 무게만 낮춘다.
 */
const THIN_SECTION_PRIOR = 5;

export interface GapInput {
  requirement: ApplicableClause[];
  matches: TestMatch[];
  /** 이 사건에 붙은 확정 DT 코드 */
  caseDtCodes: string[];
  /**
   * 통계 다리가 낸 원인 후보 (추정) — 코드마다 특이성(lift)을 함께 받는다.
   *
   * 전부 같은 무게로 두면 「설계결함」처럼 어느 사고에나 붙는 코드가 전기 관련 절을
   * 죄다 밝힌다. 04-1 §3 이 리프트를 도입한 이유가 정확히 이것이라, 그 값을 그대로
   * 무게로 쓴다 — 과열(3.26)이 설계결함(1.20)보다 2.7배 무겁다.
   */
  estimatedHf: Array<{ code: string; lift: number }>;
  limit: number;
}

export interface GapResult {
  sections: GapSection[];
  requirementClauseCount: number;
  requirementSectionCount: number;
  testedSectionCount: number;
}

/**
 * 시험하지 않은 절을 골라 이 사건과 닿는 순서로 세운다.
 *
 * 왜 전부 내놓지 않는가 (위험 2)
 *   KC 60335-1 의 성능요건만 수백 개다. 관련성 필터 없이 내놓으면
 *   "395개 중 393개를 안 했다" 가 되는데, 참이지만 쓸모가 없다.
 *   「적합을 의심하라」가 「전부 시험하라」로 번역되면 실무에서 버려진다.
 *
 * 왜 clause_hybrid_search 를 부르지 않는가
 *   그 함수는 기본 목록을 만드는 경로다. 여기서 부르면 기본 목록을 흉내 내는
 *   두 번째 경로가 생기고, 04-1 §8 이 금지한 "기본 목록 덮어쓰기" 에 가까워진다.
 *   이미 조항에 붙어 있는 코드로만 닿는지를 본다.
 */
export async function computeTestGap(input: GapInput): Promise<GapResult> {
  const sections = groupSections(input.requirement);
  const tested = new Set(input.matches.flatMap((m) => m.sectionKeys));

  const gapKeys = [...sections.keys()].filter((k) => !tested.has(k));
  const gapClauseIds = gapKeys.flatMap((k) => sections.get(k)!.clauseIds);

  const [codes, methods] = await Promise.all([
    codesByClause(gapClauseIds),
    testMethodFor(gapClauseIds),
  ]);

  const caseDt = new Set(input.caseDtCodes);
  const hfWeight = new Map(input.estimatedHf.map((c) => [c.code, c.lift]));

  /**
   * 이 조항이 이 사건과 닿는가 — 닿으면 몇 점인가.
   *
   * 피해유형은 2점 고정, 원인후보는 그 코드의 특이성(lift)만큼.
   *
   * 피해유형을 원인후보보다 무겁게 두는 이유 — 피해유형은 이 사건에 확정된 코드이고
   * 원인후보는 리콜 통계에서 추정한 값이다. 추정을 확정보다 무겁게 두면 04-1 §7 의
   * "추정이 조사 결과로 굳는" 쪽으로 한 걸음 가게 된다.
   */
  const clauseHit = (id: number): { weight: number; codes: string[] } => {
    const c = codes.get(id);
    if (!c) return { weight: 0, codes: [] };
    const dtHit = c.dt.filter((x) => caseDt.has(x));
    const hfHit = c.hf.filter((x) => hfWeight.has(x));
    return {
      weight: dtHit.length * 2 + hfHit.reduce((s, x) => s + (hfWeight.get(x) ?? 0), 0),
      codes: [...dtHit.map((x) => `피해유형 ${x}`), ...hfHit.map((x) => `원인후보 ${x}`)],
    };
  };

  // 적용 기준 전체에서의 평균 무게 — 리프트의 분모(평소 비율)를 여기서 낸다.
  // 전체는 조항이 수백 개라 얇은 근거 보정이 필요 없다
  const totalWeight = gapClauseIds.reduce((s, id) => s + clauseHit(id).weight, 0);
  const baseRate = gapClauseIds.length === 0 ? 0 : totalWeight / gapClauseIds.length;

  const out: GapSection[] = [];
  for (const k of gapKeys) {
    const g = sections.get(k)!;
    const hf = new Set<string>();
    const dt = new Set<string>();
    const related = new Set<string>();
    let methodId: number | null = null;
    let hitClauses = 0;
    let weight = 0;

    for (const id of g.clauseIds) {
      const c = codes.get(id);
      if (c) {
        for (const x of c.hf) hf.add(x);
        for (const x of c.dt) dt.add(x);
      }
      const h = clauseHit(id);
      if (h.weight > 0) {
        hitClauses++;
        weight += h.weight;
        for (const r of h.codes) related.add(r);
      }
      if (methodId === null && methods.has(id)) methodId = methods.get(id)!;
    }

    if (hitClauses === 0) continue;

    /*
      절이 크다는 이유만으로 올라오는 것을 막는다 (04-1 §3 의 리프트를 그대로 가져왔다)

      처음에는 "이 절에 우리 코드가 하나라도 붙어 있는가" 로 셌더니, 두 사건 모두
      「구조」(요건 58개)가 1위로 나왔다. 조항이 58개면 어지간한 코드는 다 품는다 —
      04-1 이 "설계결함은 어느 사고에나 붙어 리프트 0.96 으로 저절로 밀린다" 고 적은
      바로 그 현상이다.

      그래서 절 안에서의 밀도를 적용 기준 전체 밀도로 나눈다.

      순위는 리프트로 매기지 않는다 — 04-1 이 실측으로 고친 부분이다. 리프트는
      얇은 절일수록 커져서 조항 1개짜리가 9개짜리 「온도 상승」을 밀어낸다.
      건수로도 매기지 않는다 — 그러면 다시 큰 절이 이긴다(실측: 「구조」 58개 중
      34개가 닿아 1위였다).

      04-1 이 고른 답은 신뢰도, 즉 **비율**이었다. 여기서는 조항 하나당 평균 무게다.
      「구조」는 58개에 무게가 옅게 퍼져 내려가고, 「온도 상승」은 9개 중 8개가
      진하게 닿아 올라온다.

      다만 비율 그대로 쓰면 이번엔 조항 1개짜리 절이 전부 위를 차지한다(실측:
      「내구성」 1개 중 1개가 밀도 6.46 으로 1위였다). cause-bridge.ts 가
      MIN_SUPPORT=5 로 "1건짜리 우연이 리프트 최상위를 차지" 하는 것을 막은 것과
      같은 문제다.

      그쪽은 5건 미만을 잘라 냈지만 여기서는 자르지 않고 분모에 더한다. 요건이
      두세 개뿐이어도 그 절이 정말 이 사고와 닿을 수 있어서, 잘라 내면 그것까지
      사라진다. 분모에 더하면 얇은 근거는 저절로 내려가되 없어지지는 않는다.
    */
    const density = weight / (g.clauseIds.length + THIN_SECTION_PRIOR);
    const lift = baseRate === 0 ? 0 : density / baseRate;
    if (lift <= 1) continue;

    out.push({
      ...g,
      hfCodes: [...hf],
      dtCodes: [...dt],
      hitClauses,
      density: Number(density.toFixed(3)),
      lift: Number(lift.toFixed(2)),
      relatedBy: [...related],
      testMethodClauseId: methodId,
    });
  }

  out.sort((a, b) => b.density - a.density || b.hitClauses - a.hitClauses);

  return {
    sections: out.slice(0, input.limit),
    requirementClauseCount: input.requirement.length,
    requirementSectionCount: sections.size,
    testedSectionCount: tested.size,
  };
}
