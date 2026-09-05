/**
 * 「품목별 세분류 매칭 DB」 적재 — 법정 품목 ↔ GPC
 *
 * 원본은 협회가 준 엑셀 한 장이다. 소관부처가 정한 대응이라 추정이 아니라 확정이다.
 *
 * xlsx 라이브러리를 들이지 않는 이유는 scripts/build-answer-key.ts 와 같다 —
 * 파일 몇 개를 읽자고 계속 관리할 의존성을 늘리지 않는다. zip 안의 XML 을 직접 푼다.
 */

import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { getDb } from '../db';

/* ── xlsx 읽기 ─────────────────────────────────────────────────────────── */

function unzip(buf: Buffer, name: string): string {
  let p = 0;
  while (p < buf.length - 4) {
    if (buf.readUInt32LE(p) !== 0x04034b50) { p++; continue; }
    const method = buf.readUInt16LE(p + 8);
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const fname = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const dataStart = p + 30 + nameLen + extraLen;
    if (fname === name) {
      const data = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8');
    }
    p = dataStart + compSize;
  }
  throw new Error(`xlsx 안에 ${name} 이 없습니다`);
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

function readSheet(path: string): string[][] {
  const buf = readFileSync(path);
  const shared = blocks(unzip(buf, 'xl/sharedStrings.xml'), '<si>', '</si>').map((si) =>
    unescape([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')),
  );
  const rows: string[][] = [];
  for (const row of blocks(unzip(buf, 'xl/worksheets/sheet1.xml'), '<row ', '</row>')) {
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
  return rows;
}

/* ── 적재 ──────────────────────────────────────────────────────────────── */

export interface TaxonomyLoadResult {
  rows: number;
  items: number;
  bricks: number;
  /** 우리 GPC 목록(gpc_brick)에 없는 브릭 코드 */
  unknownBricks: string[];
}

/** 머리글 이름으로 열 번호를 찾는다. 열 순서가 바뀌어도 견딘다 */
function columnIndex(header: string[], name: string): number {
  const i = header.findIndex((h) => (h ?? '').trim() === name);
  if (i < 0) throw new Error(`머리글에 "${name}" 이 없습니다. 원본 형식이 바뀌었는지 확인하세요.`);
  return i;
}

export async function loadTaxonomy(path: string): Promise<TaxonomyLoadResult> {
  const sheet = readSheet(path);
  const header = (sheet[0] ?? []).map((h) => (h ?? '').trim());
  const C = {
    ministry: columnIndex(header, '소관부처'),
    law: columnIndex(header, '관련법'),
    group: columnIndex(header, '관리대상 품목군'),
    cert: columnIndex(header, '안전관리 기준'),
    item: columnIndex(header, '품목'),
    sub: columnIndex(header, '세부품목'),
    subsub: columnIndex(header, '세세부품목'),
    segT: columnIndex(header, '대분류 명칭'), segC: columnIndex(header, '대분류 코드'),
    famT: columnIndex(header, '중분류 명칭'), famC: columnIndex(header, '중분류 코드'),
    clsT: columnIndex(header, '소분류 명칭'), clsC: columnIndex(header, '소분류 코드'),
    brkT: columnIndex(header, '세분류 명칭'), brkC: columnIndex(header, '세분류 코드'),
    brkD: columnIndex(header, '세분류 정의'), brkX: columnIndex(header, '세분류 예외사항'),
  };

  const cell = (r: string[], i: number) => (r[i] ?? '').trim() || null;
  const data = sheet.slice(1).filter((r) => (r[C.item] ?? '').trim() && (r[C.brkC] ?? '').trim());

  const fileName = path.split(/[\\/]/).pop() ?? path;
  const db = getDb();

  /*
    통째로 지우고 다시 넣는다.

    협회가 개정판을 주면 행이 늘고 줄고 바뀐다. 일부만 갱신하면 없어진 행이 남아
    옛 대응이 계속 살아 있게 된다 — 품목 대응이 조용히 틀리는 것이 가장 나쁘다.
  */
  await db.begin(async (tx) => {
    await tx`delete from public.product_taxonomy`;
    for (const r of data) {
      await tx`
        insert into public.product_taxonomy
          (ministry, law, item_group, cert_scheme, item, sub_item, sub_sub_item,
           segment_code, segment_title, family_code, family_title,
           class_code, class_title, brick_code, brick_title,
           brick_definition, brick_excludes, source_file)
        values (${cell(r, C.ministry)}, ${cell(r, C.law) ?? ''}, ${cell(r, C.group) ?? ''},
                ${cell(r, C.cert) ?? ''}, ${cell(r, C.item) ?? ''}, ${cell(r, C.sub)}, ${cell(r, C.subsub)},
                ${cell(r, C.segC)}, ${cell(r, C.segT)}, ${cell(r, C.famC)}, ${cell(r, C.famT)},
                ${cell(r, C.clsC)}, ${cell(r, C.clsT)}, ${cell(r, C.brkC) ?? ''}, ${cell(r, C.brkT)},
                ${cell(r, C.brkD)}, ${cell(r, C.brkX)}, ${fileName})
      `;
    }
  });

  // 우리 브릭 목록에 없는 코드는 남겨서 알린다 — 조용히 버리면 나중에 왜 안 붙는지 모른다
  const unknown = await db<{ brick_code: string }[]>`
    select distinct t.brick_code
    from public.product_taxonomy t
    left join public.gpc_brick g on g.brick_code = t.brick_code
    where g.brick_code is null
    order by t.brick_code
  `;

  return {
    rows: data.length,
    items: new Set(data.map((r) => (r[C.item] ?? '').trim())).size,
    bricks: new Set(data.map((r) => (r[C.brkC] ?? '').trim())).size,
    unknownBricks: unknown.map((u) => u.brick_code),
  };
}
