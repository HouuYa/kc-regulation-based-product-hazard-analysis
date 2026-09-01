/**
 * 위반 표준 대조 (컨셉 1.3 넷째 질문 — 국가 간 요구 수준 차이)
 *
 * 넷째 질문에는 전제가 있다고 컨셉 8장 7번이 못박아 두었다. 상대국이 어떤 기준을
 * 근거로 조치했는지 알아야 비교가 된다는 것이다. 그래서 먼저 재 보았다.
 *
 *   2,239건 중 위반 표준이 명시된 것 625건 (27.9%)
 *   EU 52% · CN 62% · EN 21% · FR 5% · US_CPSC·AU·CA·JP 0%
 *
 * 대조가 되는 이유는 KC 전기용품 기준이 IEC 번호를 그대로 쓰기 때문이다.
 * EU 공고의 "EN 60598-2-12" 와 우리 "KC 60598-2-12" 는 같은 IEC 문서에서 왔다.
 * 반면 EN 71(완구)·GB 4706(중국 가전)은 우리 어린이제품 기준과 번호 체계가 아예
 * 달라 번호로는 이어지지 않는다 — 그쪽은 사람이 판단할 몫으로 남긴다.
 *
 * 여기서 지키는 선 하나. 번호가 완전히 같을 때만 "대조됨"이라고 한다.
 * 60598-1(공통부)과 60598-2-1(개별부)은 다른 문서다. 계열이 같다는 이유로 묶으면
 * 담당자가 엉뚱한 조항을 보게 된다. 계열만 같은 것은 참고로만 알린다.
 */

import { getDb } from '../db';

/** EN 71-1, IEC 60335-2-98, EN IEC 62368-1, GB 4706, AS/NZS 60335, BS 1363 … */
const STANDARD_TOKEN =
  /\b(EN\s?IEC|AS\/NZS|EN|IEC|ISO|ASTM|GB|JIS|BS|UL)\s?([A-Z]?\s?\d{2,5}(?:[-–]\d+)*)/g;

export interface CitedStandard {
  /** 공고에 적힌 그대로 ("EN 60598-2-12") */
  raw: string;
  /** 번호만 ("60598-2-12") */
  number: string;
  /** 표준 계열 ("EN", "GB", "IEC" …) */
  family: string;
}

/** 리콜 공고 서술에서 위반 표준을 뽑는다 */
export function extractCitedStandards(text: string | null | undefined): CitedStandard[] {
  if (!text) return [];
  const seen = new Map<string, CitedStandard>();
  for (const m of text.matchAll(STANDARD_TOKEN)) {
    const family = m[1].replace(/\s+/g, ' ').trim().toUpperCase();
    const number = m[2].replace(/\s+/g, '').replace(/–/g, '-');
    const raw = `${family} ${number}`;
    if (!seen.has(raw)) seen.set(raw, { raw, number, family });
  }
  return [...seen.values()];
}

export interface CrosswalkHit {
  cited: CitedStandard;
  standardId: number;
  displayName: string;
  /** EXACT = 번호가 완전히 같다 / SERIES = 계열만 같다(참고) */
  relation: 'EXACT' | 'SERIES';
}

export interface CrosswalkResult {
  cited: CitedStandard[];
  hits: CrosswalkHit[];
  /** 대조된 KC 기준 id (EXACT 만) */
  standardIds: number[];
  /** 왜 이 결론인지 한 줄로. 화면과 감사에 그대로 쓴다 */
  note: string;
}

/** 보유 KC 기준의 IEC 번호 색인. display_name "KC 60335-2-98" → "60335-2-98" */
async function kcIndex(): Promise<Map<string, { id: number; name: string }>> {
  const db = getDb();
  const rows = await db<{ id: number; display_name: string }[]>`
    select id, display_name from public.standard where is_current
  `;
  const idx = new Map<string, { id: number; name: string }>();
  for (const r of rows) {
    const m = r.display_name.match(/\b(\d{4,5}(?:-\d+)+|\d{4,5})\b/);
    if (m) idx.set(m[1], { id: r.id, name: r.display_name });
  }
  return idx;
}

export async function crosswalk(hazardDescription: string | null): Promise<CrosswalkResult> {
  const cited = extractCitedStandards(hazardDescription);
  if (cited.length === 0) {
    return {
      cited: [], hits: [], standardIds: [],
      note: '공고에 위반 표준이 명시되지 않았습니다 — 해외 리콜의 72%가 여기 해당합니다. 기준 수준 비교는 할 수 없습니다.',
    };
  }

  const idx = await kcIndex();
  const hits: CrosswalkHit[] = [];

  for (const c of cited) {
    const exact = idx.get(c.number);
    if (exact) {
      hits.push({ cited: c, standardId: exact.id, displayName: exact.name, relation: 'EXACT' });
      continue;
    }
    // 계열만 같은 경우 — 참고로만 알린다. 60598-1 과 60598-2-1 은 다른 문서다
    const base = c.number.split('-')[0];
    for (const [num, v] of idx) {
      if (num.split('-')[0] === base) {
        hits.push({ cited: c, standardId: v.id, displayName: v.name, relation: 'SERIES' });
        break;
      }
    }
  }

  const exactHits = hits.filter((h) => h.relation === 'EXACT');
  const seriesOnly = hits.filter((h) => h.relation === 'SERIES');
  const unmatched = cited.filter((c) => !hits.some((h) => h.cited.raw === c.raw));

  const parts: string[] = [];
  if (exactHits.length) {
    parts.push(`대조됨 ${exactHits.map((h) => `${h.cited.raw} = ${h.displayName}`).join(', ')}`);
  }
  if (seriesOnly.length) {
    parts.push(`계열만 일치(참고) ${seriesOnly.map((h) => `${h.cited.raw} ~ ${h.displayName}`).join(', ')}`);
  }
  if (unmatched.length) {
    parts.push(`보유하지 않은 표준 ${unmatched.map((c) => c.raw).join(', ')} — 번호 체계가 달라 사람이 판단해야 합니다`);
  }

  return {
    cited,
    hits,
    standardIds: [...new Set(exactHits.map((h) => h.standardId))],
    note: parts.join(' / '),
  };
}
