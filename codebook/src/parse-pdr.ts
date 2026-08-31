/**
 * PDR(제품_위해요인_분류체계_정립_PDR_v0_9_7.md) → 코드북 구조체 파서
 *
 * 설계문서 §2.4.4 "표 구조는 실물 MD를 보고 정한다" 의 실행 결과.
 * 실물에서 확인한 사실:
 *   - HF 는 계위가 가변이다. HF.UNKNOWN(2단) / HF.M.DES(3단) / HF.H.ELEC.NPC(4단)
 *   - DT 는 3단 고정이다.
 *   - HF 표의 4번째 열 이름이 절마다 다르다 → 헤더명으로 매핑한다
 *   - 중분류(HF.H.ELEC)는 표의 행이 아니라 #### 제목에만 나온다 → 제목에서 뽑는다
 *   - HF.S.INTL, HF.M.REG 같은 중간 계위는 어디에도 행이 없다 → 자동 보완한다
 */

import { extractTables, pickHeader, cleanCell, type MarkdownTable } from './markdown-table.js';
import type {
  CodebookParseResult,
  CodeConstraint,
  CodeKeyword,
  DamageTypeCode,
  DtGroup,
  HazardFactorCode,
  MshellLevel1,
  ParseFailure,
} from './types.js';

const MSHELL_LEVELS: MshellLevel1[] = ['H', 'S', 'M', 'E', 'L0', 'L1', 'UNKNOWN'];
const DT_GROUPS: DtGroup[] = [
  'THERMAL', 'ELECTRIC', 'MECHANICAL', 'ASPHYX',
  'CHEMICAL', 'BODY', 'NON-PHYS', 'OTHER',
];

/** "HF.H.ELEC.NPC" 처럼 생겼는가 (표 안의 설명문을 코드로 착각하지 않기 위한 방어) */
const HF_CODE_RE = /^HF\.[A-Z0-9-]+(?:\.[A-Z0-9-]+){0,2}$/;
const DT_CODE_RE = /^DT\.[A-Z-]+\.[A-Z-]+$/;

function isUnder(table: MarkdownTable, sectionPrefix: string): boolean {
  return table.headingPath.some((h) => h.startsWith(sectionPrefix));
}

/** "3~5" → [3,5] / "5" → [5,5] / "" → [null,null] */
function parseSeverityRange(raw: string): [number | null, number | null] {
  const s = cleanCell(raw).replace(/\s/g, '');
  if (!s) return [null, null];
  const range = /^(\d)[~\-–](\d)$/.exec(s);
  if (range) return [Number(range[1]), Number(range[2])];
  const single = /^(\d)$/.exec(s);
  if (single) return [Number(single[1]), Number(single[1])];
  return [null, null];
}

function hfParts(code: string): {
  level1: MshellLevel1;
  l2: string | null;
  l3: string | null;
  depth: number;
} {
  const seg = code.split('.');
  const raw = seg[1] ?? 'UNKNOWN';
  const level1 = (MSHELL_LEVELS as string[]).includes(raw) ? (raw as MshellLevel1) : 'UNKNOWN';
  return {
    level1,
    l2: seg[2] ?? null,
    l3: seg[3] ?? null,
    depth: seg.length,
  };
}

/** L0·L1 은 리콜 통계에서 단독 사용이 드물어 기본 목록에 노출하지 않는다 (PDR 부록 A 비고) */
function isRecallCommon(code: string): boolean {
  return !/^HF\.L[01]\b/.test(code);
}

// ---------------------------------------------------------------------------
// HF
// ---------------------------------------------------------------------------

function parseHazardFactors(
  tables: MarkdownTable[],
  markdown: string,
  failures: ParseFailure[],
): HazardFactorCode[] {
  const byCode = new Map<string, HazardFactorCode>();

  // 이미 있는 코드는 내용이 더 채워진 쪽을 남긴다
  // (제목에서 먼저 들어온 뒤 표가 상세를 덮어쓰는 순서를 허용하기 위함)
  const put = (hf: HazardFactorCode) => {
    const prev = byCode.get(hf.code);
    if (!prev) {
      byCode.set(hf.code, hf);
      return;
    }
    byCode.set(hf.code, {
      ...prev,
      name_ko: hf.name_ko || prev.name_ko,
      name_en: hf.name_en ?? prev.name_en,
      definition: hf.definition ?? prev.definition,
      mshell_link: hf.mshell_link ?? prev.mshell_link,
      example: hf.example ?? prev.example,
    });
  };

  // (1) 대분류 — §0.5 표: "**HF.H**" | "H = Hardware" | "하드웨어" | 설명
  for (const t of tables) {
    if (!isUnder(t, '0.5') && !t.nearestHeading.startsWith('대분류')) continue;
    const hCode = pickHeader(t.headers, ['대분류 코드', '코드']);
    const hEl = pickHeader(t.headers, ['M-SHELL 요소']);
    const hKo = pickHeader(t.headers, ['한국어 뜻', '한국어']);
    const hDesc = pickHeader(t.headers, ['쉬운 설명']);
    if (!hCode || !hKo) continue;

    for (const row of t.rows) {
      const code = cleanCell(row[hCode]);
      if (!HF_CODE_RE.test(code)) continue;
      const p = hfParts(code);
      // "H = Hardware" → name_en "Hardware"
      const el = hEl ? cleanCell(row[hEl]) : '';
      const nameEn = el.includes('=') ? el.split('=').slice(1).join('=').trim() : el || null;
      put({
        code,
        mshell_level1: p.level1,
        category_l2: p.l2,
        category_l3: p.l3,
        depth: p.depth,
        name_ko: cleanCell(row[hKo]),
        name_en: nameEn,
        definition: hDesc ? cleanCell(row[hDesc]) || null : null,
        mshell_link: null,
        example: null,
        is_recall_common: isRecallCommon(code),
        source_section: '§0.5 HF 코드 약어 사전',
      });
    }
  }

  // (2) 중분류 — "#### 5.1.1 HF.H.ELEC — 전기적 위해" 제목에서만 나온다
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#{3,4}\s+[\d.]+\s+(HF\.[A-Z0-9.]+)\s*[—-]\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const code = m[1].trim();
    if (!HF_CODE_RE.test(code)) continue;
    const p = hfParts(code);
    put({
      code,
      mshell_level1: p.level1,
      category_l2: p.l2,
      category_l3: p.l3,
      depth: p.depth,
      name_ko: cleanCell(m[2]).replace(/\s*※.*$/, ''),
      name_en: null,
      definition: null,
      mshell_link: null,
      example: null,
      is_recall_common: isRecallCommon(code),
      source_section: line.trim().replace(/^#+\s*/, ''),
    });
  }

  // (3) 소분류 — §5 의 표 본체
  for (const t of tables) {
    if (!isUnder(t, '§5.')) continue;
    const hCode = pickHeader(t.headers, ['코드']);
    const hKo = pickHeader(t.headers, ['한국어명']);
    if (!hCode || !hKo) continue;

    const hDef = pickHeader(t.headers, ['정의']);
    const hLink = pickHeader(t.headers, ['M-SHELL 연계']);
    const hEx = pickHeader(t.headers, ['해외 리콜 사례', '사례']);

    t.rows.forEach((row, idx) => {
      const code = cleanCell(row[hCode]);
      if (!code) return;
      if (!HF_CODE_RE.test(code)) {
        failures.push({
          section: t.nearestHeading,
          line_no: t.rowLineNumbers[idx],
          raw: JSON.stringify(row),
          reason: 'HF 코드 형식이 아님: ' + code,
        });
        return;
      }
      const p = hfParts(code);
      put({
        code,
        mshell_level1: p.level1,
        category_l2: p.l2,
        category_l3: p.l3,
        depth: p.depth,
        name_ko: cleanCell(row[hKo]),
        name_en: null,
        definition: hDef ? cleanCell(row[hDef]) || null : null,
        mshell_link: hLink ? cleanCell(row[hLink]) || null : null,
        example: hEx ? cleanCell(row[hEx]) || null : null,
        is_recall_common: isRecallCommon(code),
        source_section: t.nearestHeading,
      });
    });
  }

  // (4) 중간 계위 보완 — HF.S.INTL, HF.M.REG 는 문서에 행이 없지만
  //     부록 G 와 §4.2 가 중분류로 참조하므로 계위가 끊기면 resolve_code 가 실패한다
  for (const code of [...byCode.keys()]) {
    const seg = code.split('.');
    for (let n = 2; n < seg.length; n++) {
      const parent = seg.slice(0, n).join('.');
      if (byCode.has(parent)) continue;
      const p = hfParts(parent);
      byCode.set(parent, {
        code: parent,
        mshell_level1: p.level1,
        category_l2: p.l2,
        category_l3: p.l3,
        depth: p.depth,
        name_ko: p.l2 ?? p.level1,
        name_en: null,
        definition: null,
        mshell_link: null,
        example: null,
        is_recall_common: isRecallCommon(parent),
        source_section: '자동생성(상위 계위 보완)',
      });
    }
  }

  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// DT
// ---------------------------------------------------------------------------

function parseDamageTypes(
  tables: MarkdownTable[],
  failures: ParseFailure[],
): DamageTypeCode[] {
  const byCode = new Map<string, DamageTypeCode>();

  // (1) §6.1.x 본체 표
  for (const t of tables) {
    if (!isUnder(t, '§6.')) continue;
    const hCode = pickHeader(t.headers, ['코드']);
    const hKo = pickHeader(t.headers, ['한국어명']);
    if (!hCode || !hKo) continue;

    const hDef = pickHeader(t.headers, ['정의']);
    const hSev = pickHeader(t.headers, ['ISO 5665 심각도', '심각도']);
    const hPrism = pickHeader(t.headers, ['PRISM Risk Level', 'PRISM']);
    const hEu = pickHeader(t.headers, ['EU Safety Gate']);

    t.rows.forEach((row, idx) => {
      const code = cleanCell(row[hCode]);
      if (!code) return;
      if (!DT_CODE_RE.test(code)) {
        failures.push({
          section: t.nearestHeading,
          line_no: t.rowLineNumbers[idx],
          raw: JSON.stringify(row),
          reason: 'DT 코드 형식이 아님: ' + code,
        });
        return;
      }
      const group = code.split('.')[1] as DtGroup;
      if (!DT_GROUPS.includes(group)) {
        failures.push({
          section: t.nearestHeading,
          line_no: t.rowLineNumbers[idx],
          raw: code,
          reason: '알 수 없는 DT 중분류: ' + group,
        });
        return;
      }
      const [min, max] = hSev ? parseSeverityRange(row[hSev]) : [null, null];
      byCode.set(code, {
        code,
        dt_group: group,
        name_ko: cleanCell(row[hKo]),
        name_en: null,
        definition: hDef ? cleanCell(row[hDef]) || null : null,
        severity_min: min,
        severity_max: max,
        prism_risk_level: hPrism ? cleanCell(row[hPrism]) || null : null,
        eu_safetygate_type: hEu ? cleanCell(row[hEu]).replace(/^—$/, '') || null : null,
        source_section: t.nearestHeading,
      });
    });
  }

  // (2) §0.6 요약표에서 영문명(약어 원문) 보강
  for (const t of tables) {
    if (!isUnder(t, '0.6')) continue;
    const hCode = pickHeader(t.headers, ['코드']);
    const hEn = pickHeader(t.headers, ['약어 원문']);
    if (!hCode || !hEn) continue;
    for (const row of t.rows) {
      const code = cleanCell(row[hCode]);
      const target = byCode.get(code);
      if (!target) continue;
      target.name_en = cleanCell(row[hEn]) || null;
    }
  }

  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// 조합 제약
// ---------------------------------------------------------------------------

/**
 * 제약은 표가 아니라 산문·경고 블록에 있어 표 파싱으로는 잡히지 않는다.
 * PDR 원문의 규칙을 그대로 옮기고 출처 절을 남긴다 — 근거 없는 규칙을 만들지 않기 위함.
 */
function buildConstraints(): CodeConstraint[] {
  return [
    {
      subject_prefix: 'HF.L0',
      rule_type: 'REQUIRES_ANY_OF',
      requires_any_of: ['HF.M.DES', 'HF.M.QMS'],
      reason: '사용자 행동은 계기이고 근본 원인은 설계·관리 결함이므로 단독 사용을 금지한다',
      source_section: '§0.4 · §4.4 (L0·L1 단독 사용 금지)',
    },
    {
      subject_prefix: 'HF.L1',
      rule_type: 'REQUIRES_ANY_OF',
      requires_any_of: ['HF.M.DES', 'HF.M.QMS'],
      reason: '주변 관련자 행동이 계기여도 안전정보 전달 체계 결함(HF.M.QMS)이 근본 원인이다',
      source_section: '§0.4 · §5.6 (L1 비고)',
    },
    {
      subject_prefix: 'HF.M.REG.UNMANAGED',
      rule_type: 'RECOMMENDS_ANY_OF',
      requires_any_of: ['HF.S.NATL.ABS', 'HF.S.INTL.ABS'],
      reason: '비관리대상 제품은 관리체계 밖(M)이면서 동시에 적용 기준이 없는 상태(S)이다',
      source_section: '§5.3 적용 기준',
    },
  ];
}

// ---------------------------------------------------------------------------
// 키워드 (부록 G)
// ---------------------------------------------------------------------------

function parseKeywords(tables: MarkdownTable[]): CodeKeyword[] {
  const out: CodeKeyword[] = [];

  for (const t of tables) {
    const isG1 = isUnder(t, 'G.1');
    const isG2 = isUnder(t, 'G.2');
    if (!isG1 && !isG2) continue;

    const hGroup = pickHeader(t.headers, ['키워드 그룹']);
    const hWords = pickHeader(t.headers, ['키워드 예시']);
    const hCodes = pickHeader(t.headers, ['연결 HF 코드', '연결 DT 코드']);
    if (!hGroup || !hWords || !hCodes) continue;

    const axis: 'HF' | 'DT' = isG1 ? 'HF' : 'DT';
    for (const row of t.rows) {
      const group = cleanCell(row[hGroup]);
      const words = cleanCell(row[hWords]).split(',').map((w) => w.trim()).filter(Boolean);
      const codes = cleanCell(row[hCodes]).split(',').map((c) => c.trim()).filter(Boolean);
      for (const code of codes) {
        for (const keyword of words) {
          out.push({
            axis,
            code,
            keyword,
            keyword_group: group,
            source_section: isG1 ? '부록 G.1' : '부록 G.2',
          });
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------

export function parsePdr(markdown: string): CodebookParseResult {
  const tables = extractTables(markdown);
  const failures: ParseFailure[] = [];

  return {
    hazard_factors: parseHazardFactors(tables, markdown, failures),
    damage_types: parseDamageTypes(tables, failures),
    constraints: buildConstraints(),
    keywords: parseKeywords(tables),
    failures,
  };
}

/** 파일명에서 버전을 뽑는다 — "..._PDR_v0_9_7.md" → "v0.9.7" */
export function versionFromFilename(filename: string): string | null {
  const m = /_v(\d+(?:_\d+)*)\.md$/i.exec(filename);
  if (!m) return null;
  return 'v' + m[1].replace(/_/g, '.');
}
