/**
 * 엑셀 읽기 (CLAUDE.md §9)
 *
 * 왜 라이브러리를 안 쓰나
 *   xlsx 는 zip 안의 XML 이다. 파일 몇 개를 읽자고 의존성을 늘리면 그것도 계속
 *   관리해야 한다. 필요한 만큼만 직접 푼다 — scripts/build-answer-key.ts 가 처음
 *   이렇게 했고, 읽을 파일이 셋으로 늘어 여기로 모았다.
 *
 * 시트를 이름으로 고를 수 있어야 한다
 *   협회 파일은 한 통에 여러 시트가 들어온다(전기용품·생활용품·어린이제품·제외어).
 *   sheet1 만 읽던 방식으로는 감당할 수 없다.
 */

import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

export interface Sheet {
  name: string;
  rows: string[][];
}

function entries(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (p < buf.length - 4) {
    if (buf.readUInt32LE(p) !== 0x04034b50) { p++; continue; }
    const method = buf.readUInt16LE(p + 8);
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const fname = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + compSize);
    try {
      out[fname] = method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8');
    } catch {
      // 압축 방식이 다른 항목은 건너뛴다. 우리가 읽을 것은 XML 뿐이다
    }
    p = start + compSize;
  }
  return out;
}

function blocks(xml: string, open: string, close: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const a = xml.indexOf(open, i);
    if (a < 0) break;
    const b = xml.indexOf(close, a);
    if (b < 0) break;
    out.push(xml.slice(a, b));
    i = b + close.length;
  }
  return out;
}

const unescape = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** 통합문서의 모든 시트를 이름과 함께 읽는다 */
export function readWorkbook(path: string): Sheet[] {
  const z = entries(readFileSync(path));

  const shared = blocks(z['xl/sharedStrings.xml'] ?? '', '<si>', '</si>').map((si) =>
    unescape([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')),
  );

  const names = [...(z['xl/workbook.xml'] ?? '').matchAll(/<sheet[^>]*name="([^"]*)"/g)]
    .map((m) => unescape(m[1]));

  const keys = Object.keys(z)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));

  return keys.map((k, idx) => {
    const rows: string[][] = [];
    for (const row of blocks(z[k], '<row ', '</row>')) {
      const cells: string[] = [];
      for (const m of row.matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
        let col = 0;
        for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
        col -= 1;
        const v = m[3].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
        const inline = [...m[3].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('');
        cells[col] = /t="s"/.test(m[2]) && v ? (shared[Number(v)] ?? '') : unescape(v || inline);
      }
      rows.push(cells);
    }
    return { name: names[idx] ?? k, rows };
  });
}

/** 시트 하나를 이름으로 가져온다 */
export function sheetByName(sheets: Sheet[], name: string): Sheet | null {
  return sheets.find((s) => s.name.trim() === name) ?? null;
}

/** 머리글 이름으로 열 번호를 찾는다. 열 순서가 바뀌어도 견딘다 */
export function columnIndex(header: string[], name: string): number {
  const i = header.findIndex((h) => (h ?? '').trim() === name);
  if (i < 0) throw new Error(`머리글에 "${name}" 이 없습니다. 원본 형식이 바뀌었는지 확인하세요.`);
  return i;
}
