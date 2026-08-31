/**
 * 마크다운 표 파서 (범용)
 *
 * 왜 헤더명으로 매핑하는가:
 *   PDR §5 의 표는 4번째 열이 절마다 다르다 —
 *   §5.1 은 "해외 리콜 사례", §5.2·5.3 은 "M-SHELL 연계", §5.1.4 는 "사례".
 *   열 위치로 읽으면 절 하나만 바뀌어도 조용히 어긋난다.
 */

export interface MarkdownTable {
  /** 이 표가 속한 제목 경로 — 예: ["## §5. 위해요인 코드 체계 (HF)", "### 5.1 ...", "#### 5.1.1 ..."] */
  headingPath: string[];
  /** 가장 가까운 제목 (표의 소속을 판정할 때 쓴다) */
  nearestHeading: string;
  /** 정규화된 헤더 셀 */
  headers: string[];
  /** 헤더명 → 값 으로 매핑된 행 */
  rows: Array<Record<string, string>>;
  /** 각 행이 원문 몇 번째 줄이었는지 (파싱 실패 보고용) */
  rowLineNumbers: number[];
}

const SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** 셀 안의 마크다운 장식을 걷어낸다. 코드값은 백틱에 싸여 있다. */
export function cleanCell(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/<mark[^>]*>/gi, '')
    .replace(/<\/mark>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(cleanCell);
}

function isTableLine(line: string): boolean {
  return line.trim().startsWith('|');
}

/**
 * 문서 전체에서 표를 뽑아 제목 경로와 함께 돌려준다.
 * 인용문(>) 안의 표는 본문 표가 아니므로 건너뛴다.
 */
export function extractTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  // 제목 깊이(1~6) → 제목 텍스트
  const headingStack: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      headingStack.length = Math.max(0, depth - 1);
      headingStack[depth - 1] = heading[2].trim();
      continue;
    }

    if (line.trim().startsWith('>')) continue;
    if (!isTableLine(line)) continue;

    // 표 후보: 다음 줄이 구분선이어야 한다
    const sep = lines[i + 1];
    if (!sep || !SEPARATOR_RE.test(sep)) continue;

    const headers = splitRow(line);
    const rows: Array<Record<string, string>> = [];
    const rowLineNumbers: number[] = [];

    let j = i + 2;
    for (; j < lines.length && isTableLine(lines[j]); j++) {
      const cells = splitRow(lines[j]);
      // 전부 빈 칸인 행은 PDR 에 실제로 존재한다(표 끝의 여백 행) — 버린다
      if (cells.every((c) => c === '')) continue;
      const row: Record<string, string> = {};
      headers.forEach((h, k) => {
        row[h] = cells[k] ?? '';
      });
      rows.push(row);
      rowLineNumbers.push(j + 1); // 1-indexed
    }

    const path = headingStack.filter(Boolean);
    tables.push({
      headingPath: [...path],
      nearestHeading: path[path.length - 1] ?? '',
      headers,
      rows,
      rowLineNumbers,
    });

    i = j - 1;
  }

  return tables;
}

/** 헤더 목록에서 후보 이름 중 처음 일치하는 것을 찾는다 (열 이름 변형 흡수) */
export function pickHeader(headers: string[], candidates: string[]): string | null {
  for (const c of candidates) {
    const hit = headers.find((h) => h === c);
    if (hit) return hit;
  }
  // 부분 일치로 한 번 더 — "ISO 5665 심각도" 같은 접미 변형 흡수
  for (const c of candidates) {
    const hit = headers.find((h) => h.includes(c));
    if (hit) return hit;
  }
  return null;
}
