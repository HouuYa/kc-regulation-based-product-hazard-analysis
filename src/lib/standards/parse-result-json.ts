/**
 * KC안전기준 파싱 JSON → 조항·참조·시험조건
 *
 * 설계문서 §5.2.5 가 지적한 이점이 여기서 실현된다.
 * 일반 RAG 의 최대 난제인 "몇 글자로 자를 것인가"를 우리는 고민하지 않는다 —
 * 표준 문서의 계위가 이미 의미 단위를 정해 두었고, 파싱 JSON 이 그 계위를
 * hierarchy 로 넘겨준다. 조항 하나가 곧 한 조각이다.
 */

import { createHash } from 'node:crypto';
import type {
  CertScheme,
  HierarchyItem,
  ParsedClause,
  ParsedClauseLink,
  ParsedStandard,
  ParsedTestCondition,
  StandardMeta,
  StandardResultJson,
} from './types.js';

// -----------------------------------------------------------------------------
// 파일명 → 기준 메타
// -----------------------------------------------------------------------------

const CERT_SCHEMES: CertScheme[] = ['안전인증', '안전확인', '공급자적합성', '안전기준준수'];

/**
 * 실물 파일명 유형 세 가지
 *   "5. 안전확인 부속서 8(유아용 의자)_result (1).json"
 *   "16. 공급자적합성 공통안전기준(기타어린이제품)_result.json"
 *   "1. KC 60335-2-13_result.json"
 */
export function parseFilename(filename: string): Omit<StandardMeta,
  'source_sha256' | 'total_pages' | 'parser_model' | 'ocr_confidence'> {
  // 앞의 일련번호와 뒤의 _result / (1) / .json 을 걷어낸다
  const core = filename
    .replace(/\.json$/i, '')
    .replace(/_result(\s*\(\d+\))?$/i, '')
    .replace(/^\d+\.\s*/, '')
    .trim();

  const cert = CERT_SCHEMES.find((c) => core.startsWith(c));
  const annex = /부속서\s*([0-9A-Za-z-]+)/.exec(core);
  const paren = /\(([^)]*)\)\s*$/.exec(core);
  const stdNo = /^((?:KC|K)\s*[0-9][0-9A-Za-z.-]*)/.exec(core);

  const itemName = paren ? paren[1].trim() : null;

  return {
    source_filename: filename,
    cert_scheme: cert ?? (stdNo ? '전기용품' : '미상'),
    annex_no: annex ? annex[1] : null,
    item_name: itemName,
    standard_no: stdNo ? stdNo[1].replace(/\s+/g, ' ').trim() : null,
    display_name: core,
  };
}

// -----------------------------------------------------------------------------
// 조항
// -----------------------------------------------------------------------------

function cleanText(s: string | undefined | null): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 같은 조항이 페이지를 넘어 두 번 나오는 경우가 있다.
 * 부(part)가 다르면 같은 번호라도 다른 조항이므로 part 를 키에 넣는다.
 */
function clauseKey(part: string | null, marker: string): string {
  return `${part ?? ''}|${marker}`;
}

function collectClauses(pages: { page_number: number; hierarchy?: HierarchyItem[] }[]): {
  clauses: ParsedClause[];
  warnings: string[];
} {
  const byKey = new Map<string, ParsedClause>();
  const warnings: string[] = [];
  let order = 0;

  // 표(LT)는 hierarchy 에서 marker 가 없어 독립 조항이 되지 못한다.
  // 문서 순서상 직전 조항에 딸린 표이므로 그 조항에 붙인다.
  let lastKey: string | null = null;

  for (const page of pages) {
    for (const h of page.hierarchy ?? []) {
      const marker = cleanText(h.marker);
      if (!marker) {
        const caption = h.caption ?? '';
        if (/<table/i.test(caption) && lastKey) {
          const owner = byKey.get(lastKey);
          if (owner && !owner.tables.includes(caption)) owner.tables.push(caption);
        }
        continue;
      }
      const part = h.part ?? null;
      const key = clauseKey(part, marker);
      lastKey = key;

      // title 이 본문으로 흘러넘친 항목이 많아 text 를 본문의 기준으로 삼는다.
      const body = cleanText(h.text) || cleanText(h.title);

      const existing = byKey.get(key);
      if (existing) {
        // 페이지를 넘어 이어진 조항 — 본문을 잇는다
        if (body && !existing.body.includes(body)) {
          existing.body = `${existing.body} ${body}`.trim();
        }
        if (h.caption && /<table/i.test(h.caption) && !existing.tables.includes(h.caption)) {
          existing.tables.push(h.caption);
        }
        continue;
      }

      const crumbs = (h.breadcrumb ?? []).filter(Boolean);
      const pathParts = [part, ...crumbs, marker].filter(Boolean) as string[];

      byKey.set(key, {
        marker,
        part,
        breadcrumb_path: pathParts.join(' > '),
        level_code: h.level_code ?? null,
        level_name: h.level_name ?? null,
        clause_type: h.type ?? null,
        title_raw: cleanText(h.title) || null,
        body,
        page_no: page.page_number ?? null,
        parse_confidence: typeof h.confidence === 'number' ? h.confidence : null,
        order_index: order++,
        tables: h.caption && /<table/i.test(h.caption) ? [h.caption] : [],
      });
    }
  }

  const clauses = [...byKey.values()];
  const empty = clauses.filter((c) => !c.body).length;
  if (empty > 0) {
    warnings.push(`본문이 빈 조항 ${empty}건 — 제목만 있는 절이거나 추출 실패`);
  }
  return { clauses, warnings };
}

// -----------------------------------------------------------------------------
// 조항 간 참조 (설계문서 결정항목 1)
// -----------------------------------------------------------------------------

/**
 * 조항 참조 표현을 잡는다.
 *
 *   "5.9.2 및 5.9.3 에 따른 시험 시"     숫자 계위
 *   "5.7에 따라 시험했을 때"
 *   "부록 D.1에 따라 시험했을 때"        알파벳 부록 계위 — 공통안전기준이 이 방식이다
 *
 * 번호 뒤에 반드시 따라/따른/규정 같은 서술이 와야 참조로 본다.
 * 그렇게 하지 않으면 "150 N", "그림 4", "0.5 mm" 가 전부 조항번호로 잡힌다.
 */
const REF_TOKEN = String.raw`(?:[A-Z]\.\d+(?:\.\d+)*|\d+(?:\.\d+)+)`;
const REFERENCE_RE = new RegExp(
  String.raw`(?:(?:부록|부속서|별표)\s*)?(` +
    REF_TOKEN +
    String.raw`(?:\s*(?:및|,|·|과|와|또는|~)\s*` +
    REF_TOKEN +
    String.raw`)*)\s*(?:항|조)?\s*(?:에|에서)?\s*(?:따라|따른|따를|규정|의한|의하여|준하여|명시)`,
  'g',
);
const REF_TOKEN_RE = new RegExp(REF_TOKEN, 'g');

/**
 * 최상위 절을 통째로 가리키는 참조 — "5. 시험방법에 따라 시험하였을 때"
 *
 * 한 자리 숫자만으로는 수치와 구분되지 않으므로, 절 이름이 바로 뒤따를 때만 참조로 본다.
 * 안전기준준수 계열이 이 방식으로 시험방법을 가리킨다.
 */
const SECTION_REFERENCE_RE =
  /(\d{1,2})\.?\s*(?:시험방법|시험|안전요건|표시사항)\s*(?:에|에서)?\s*(?:따라|따른|의한|의하여)/g;

/**
 * 다른 표준을 가리키는 참조 — "KS M 1998에 따른다", "KS C IEC 62321-6에 따른다"
 * 우리 DB 에 그 표준이 없으므로 연결하지 않고 건수만 세어 경고로 알린다.
 */
const EXTERNAL_STANDARD_RE =
  /\b(?:KS|IEC|ISO|EN|ASTM)\s+[A-Z]*\s*[\d-]+[\w-]*\s*(?:에|에서)?\s*(?:따라|따른다|따른|의한)/g;

/**
 * 성능요건 → 시험방법 연결인가.
 *
 * 판정 근거 두 가지 — 어느 쪽이든 걸리면 시험방법으로 본다.
 *   1) 참조 문구 자체가 시험을 말한다 — "…에 따라 시험했을 때"
 *   2) 대상의 최상위 절 제목이 시험이다 — 부속서 8 의 "5 시험방법"
 *
 * 기준마다 시험방법을 두는 자리가 다르기 때문에 한 가지 근거로는 부족하다.
 * 부속서 8 은 "5 시험" 절에 두고, 공통안전기준은 "부록 D" 에 둔다.
 */
function isTestReference(
  marker: string,
  evidence: string,
  rootTitleByNumber: Map<string, string>,
): boolean {
  if (/시\s*험/.test(evidence)) return true;
  const root = marker.split('.')[0];
  return /시\s*험/.test(rootTitleByNumber.get(root) ?? '');
}

function extractLinks(
  clauses: ParsedClause[],
  testConditions: ParsedTestCondition[],
): ParsedClauseLink[] {
  const existing = new Set(clauses.map((c) => clauseKey(c.part, c.marker)));
  // 부를 무시한 조항번호 집합 — 다른 부를 가리키는 참조를 구분하기 위함
  const markersAnyPart = new Set(clauses.map((c) => c.marker));

  // 최상위 절(예: "5")의 제목을 모아 둔다
  const rootTitleByNumber = new Map<string, string>();
  for (const c of clauses) {
    if (!c.marker.includes('.')) {
      rootTitleByNumber.set(c.marker, c.title_raw ?? c.body);
    }
  }

  const links: ParsedClauseLink[] = [];
  const seen = new Set<string>();

  const push = (l: ParsedClauseLink) => {
    const k = `${l.from_part ?? ''}|${l.from_marker}|${l.to_marker}|${l.link_source}`;
    if (seen.has(k)) return;
    seen.add(k);
    links.push(l);
  };

  // (1) 본문 참조
  for (const c of clauses) {
    if (!c.body) continue;
    REFERENCE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REFERENCE_RE.exec(c.body)) !== null) {
      REF_TOKEN_RE.lastIndex = 0;
      const targets = m[1].match(REF_TOKEN_RE) ?? [];
      const start = Math.max(0, m.index - 20);
      const evidence = c.body.slice(start, Math.min(c.body.length, m.index + m[0].length + 25)).trim();

      for (const t of targets) {
        if (t === c.marker) continue; // 자기 참조
        // 같은 부 안에 없으면 다른 부 또는 다른 기준(제1부)을 가리키는 참조다.
        // 버리지 않고 resolved=false 로 남긴다.
        const inSamePart = existing.has(clauseKey(c.part, t));
        const inOtherPart = !inSamePart && markersAnyPart.has(t);
        push({
          from_marker: c.marker,
          to_marker: t,
          from_part: c.part,
          link_source: 'TEXT',
          link_type: isTestReference(t, evidence, rootTitleByNumber) ? 'TEST_METHOD' : 'REFERENCE',
          evidence_span: evidence,
          resolved: inSamePart || inOtherPart,
        });
      }
    }

    // 최상위 절 참조 — "5. 시험방법에 따라"
    SECTION_REFERENCE_RE.lastIndex = 0;
    let sm: RegExpExecArray | null;
    while ((sm = SECTION_REFERENCE_RE.exec(c.body)) !== null) {
      const t = sm[1];
      if (t === c.marker) continue;
      if (!existing.has(clauseKey(c.part, t)) && !markersAnyPart.has(t)) continue;
      push({
        from_marker: c.marker,
        to_marker: t,
        from_part: c.part,
        link_source: 'TEXT',
        link_type: 'TEST_METHOD',
        evidence_span: c.body
          .slice(Math.max(0, sm.index - 20), sm.index + sm[0].length + 20)
          .trim(),
        resolved: true,
      });
    }
  }

  // (2) 표의 "시험방법" 열 — 표가 달린 조항이 그 시험방법을 지목한다
  for (const tc of testConditions) {
    if (!tc.test_method_marker) continue;
    push({
      from_marker: tc.clause_marker,
      to_marker: tc.test_method_marker,
      from_part: tc.part,
      link_source: 'TABLE',
      link_type: 'TEST_METHOD',
      evidence_span: `표: ${tc.item_group ? tc.item_group + ' / ' : ''}${tc.item_name} → ${tc.test_method_marker}`,
      resolved:
        existing.has(clauseKey(tc.part, tc.test_method_marker)) ||
        markersAnyPart.has(tc.test_method_marker),
    });
  }

  return links;
}

// -----------------------------------------------------------------------------
// 표 → 시험조건
// -----------------------------------------------------------------------------

/** rowspan/colspan 이 섞인 <table> 을 셀 격자로 편다 */
function parseHtmlTable(html: string): string[][] {
  const rows: string[][] = [];
  const grid: Array<Array<string | undefined>> = [];

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi;

  let trMatch: RegExpExecArray | null;
  let r = 0;
  while ((trMatch = trRe.exec(html)) !== null) {
    grid[r] ??= [];
    let td: RegExpExecArray | null;
    tdRe.lastIndex = 0;
    let c = 0;
    while ((td = tdRe.exec(trMatch[1])) !== null) {
      const attrs = td[1] ?? '';
      const text = td[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const rowspan = Number(/rowspan\s*=\s*"?(\d+)/i.exec(attrs)?.[1] ?? 1);
      const colspan = Number(/colspan\s*=\s*"?(\d+)/i.exec(attrs)?.[1] ?? 1);

      while (grid[r][c] !== undefined) c++;
      for (let dr = 0; dr < rowspan; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < colspan; dc++) {
          grid[r + dr][c + dc] = text;
        }
      }
      c += colspan;
    }
    r++;
  }

  for (const row of grid) rows.push((row ?? []).map((v) => v ?? ''));
  return rows;
}

/** "60 mg/kg 이하" → { value: 60, unit: "mg/kg" } */
function splitAllowance(raw: string): { value: number | null; unit: string | null } {
  // 기준 원문은 천 단위를 공백으로 끊어 쓴다 — "1 000 mg/kg 이하" 는 1000 이지 1 이 아니다
  const normalized = raw.replace(/(\d)[\s,](?=\d{3}(?!\d))/g, '$1');
  const m = /(-?\d+(?:\.\d+)?)\s*([A-Za-z°%㎜㎝㎏㎎/·]+(?:\/[A-Za-z]+)?)?/.exec(normalized);
  if (!m) return { value: null, unit: null };
  return {
    value: Number(m[1]),
    unit: m[2] ? m[2].trim() : null,
  };
}

function extractTestConditions(clauses: ParsedClause[]): ParsedTestCondition[] {
  const out: ParsedTestCondition[] = [];

  for (const c of clauses) {
    for (const html of c.tables) {
      const rows = parseHtmlTable(html);
      if (rows.length < 2) continue;

      const header = rows[0].map((h) => h.replace(/\s+/g, ''));

      // colspan 으로 "항 목"이 두 칸을 덮으면 헤더가 ["항목","항목",...] 로 펼쳐진다.
      // 이때 앞 칸은 상위 그룹(유해 원소 용출), 뒤 칸이 실제 항목(안티모니 (Sb)) 이다.
      const itemCols = header
        .map((h, i) => (/항목|구분/.test(h) ? i : -1))
        .filter((i) => i >= 0);
      const idxItem = itemCols.length ? itemCols[itemCols.length - 1] : -1;
      const idxAllow = header.findIndex((h) => /허용치|기준치|기준|규격|요구/.test(h));
      const idxMethod = header.findIndex((h) => /시험방법|시험/.test(h));

      // 항목·허용치가 없으면 시험조건 표가 아니다 (목차·요약표 등)
      if (idxItem === -1 || idxAllow === -1) continue;

      for (const row of rows.slice(1)) {
        const itemName = row[idxItem] ?? '';
        if (!itemName) continue;

        // 앞선 항목 열이 상위 그룹명이다
        const group =
          itemCols.length > 1 && row[itemCols[0]] && row[itemCols[0]] !== itemName
            ? row[itemCols[0]]
            : null;

        const allowance = row[idxAllow] ?? '';
        const { value, unit } = splitAllowance(allowance);
        const methodRaw = idxMethod >= 0 ? (row[idxMethod] ?? '') : '';
        const method = /^\d+(?:\.\d+)*$/.test(methodRaw.trim()) ? methodRaw.trim() : null;

        out.push({
          clause_marker: c.marker,
          part: c.part,
          item_name: itemName,
          item_group: group,
          allowance_raw: allowance || null,
          value_num: value,
          unit,
          test_method_marker: method,
          source: 'TABLE',
        });
      }
    }
  }

  return out;
}

// -----------------------------------------------------------------------------

export function parseStandardJson(filename: string, raw: string): ParsedStandard {
  const json = JSON.parse(raw) as StandardResultJson;
  const content = json.result?.content;
  const pages = content?.tagger?.pages ?? [];

  const warnings: string[] = [];
  if (pages.length === 0) warnings.push('tagger.pages 가 비어 있음 — 계위 추출 불가');

  const { clauses, warnings: clauseWarnings } = collectClauses(pages);
  warnings.push(...clauseWarnings);

  const test_conditions = extractTestConditions(clauses);
  const links = extractLinks(clauses, test_conditions);

  // 다른 표준(KS·IEC)에 시험방법을 넘기는 조항 — 우리 DB 에 그 표준이 없어 연결하지 못한다
  let externalRefs = 0;
  for (const c of clauses) {
    EXTERNAL_STANDARD_RE.lastIndex = 0;
    externalRefs += (c.body.match(EXTERNAL_STANDARD_RE) ?? []).length;
  }
  if (externalRefs > 0) {
    warnings.push(
      `외부 표준(KS·IEC 등)으로 시험방법을 넘기는 참조 ${externalRefs}건 — 해당 표준이 적재되기 전에는 연결 불가`,
    );
  }

  const meta: StandardMeta = {
    ...parseFilename(filename),
    source_sha256: createHash('sha256').update(raw).digest('hex'),
    total_pages: json.total_pages != null ? Number(json.total_pages) : null,
    parser_model: content?.tagger?.model ?? null,
    ocr_confidence:
      content?.ocr?.confidence != null ? Number(content.ocr.confidence) : null,
  };

  return { meta, clauses, links, test_conditions, warnings };
}
