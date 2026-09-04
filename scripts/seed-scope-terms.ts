/**
 * 엑셀(사고조사 건별 결함조사 항목) → 품목 용어 사전 채우기
 *
 *   npm run scopes:seed-terms
 *   npm run scopes:seed-terms -- --dry
 *
 * 담당자가 실제 사고를 조사하며 정한 "이 품목에는 이 기준" 대응을 그대로 옮긴다.
 * 사람이 정한 것이므로 source='EXPERT', review_status='approved' 로 넣는다.
 *
 * 우리 DB 에 없는 기준(KC 60598-1·KC 61347-2-1 등)은 넣지 않고 따로 보고한다.
 * 그 품목이 "못 찾는" 진짜 이유가 기준 미적재라는 것을 드러내기 위해서다 —
 * 원인이 다르면 해야 할 일도 다르다.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { getDb, closeDb } from '../src/lib/db';

const ROOT = join(import.meta.dirname, '..');
const XLSX = join(ROOT, '사고조사보고서', '__사고조사 건별 결함조사 항목 목록화_전달용.xlsx');

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

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function readSheet(): string[][] {
  const buf = readFileSync(XLSX);
  const shared = blocks(unzip(buf, 'xl/sharedStrings.xml'), '<si>', '</si>').map((si) =>
    unesc([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')),
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
      cells[col] = /t="s"/.test(m[2]) && v ? (shared[Number(v)] ?? '') : unesc(v || inline);
    }
    rows.push(cells);
  }
  return rows;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const db = getDb();
  const data = readSheet().slice(2).filter((r) => (r[1] ?? '').trim());

  const stds = await db<{ id: number; display_name: string }[]>`
    select id, display_name from public.standard where is_current
  `;
  const exact = new Map(stds.map((s) => [s.display_name.trim(), s]));
  const annexIdx = new Map<string, (typeof stds)[0]>();
  for (const s of stds) {
    const m = s.display_name.match(/^(안전확인|안전인증|공급자적합성|안전기준준수)\s*부속서\s*(\d+)/);
    if (m) annexIdx.set(`${m[1]} 부속서 ${m[2]}`, s);
  }

  /** build-answer-key.ts 와 같은 규칙. -1 은 절대 보정하지 않는다(공통부는 실재 문서) */
  function resolve(raw: string) {
    const s = raw.trim();
    if (exact.has(s)) return exact.get(s)!;
    const annex = s.replace(/^(생활용품|어린이제품)\s*/, '');
    const m = annex.match(/^(안전확인|안전인증|공급자적합성|안전기준준수)\s*부속서\s*(\d+)/);
    if (m) return annexIdx.get(`${m[1]} 부속서 ${m[2]}`) ?? null;
    const k = s.match(/^KC\s*(\d{5})-(\d+)$/);
    if (k && k[2] !== '1') return exact.get(`KC ${k[1]}-2-${k[2]}`) ?? null;
    return null;
  }

  // 품목 → 기준 이름들
  const pairs = new Map<string, Set<string>>();
  for (const r of data) {
    const item = (r[6] ?? '').trim();
    const std = (r[9] ?? '').trim();
    if (!item || !std || std === '-') continue;
    if (!pairs.has(item)) pairs.set(item, new Set());
    pairs.get(item)!.add(std);
  }

  let inserted = 0;
  const missing = new Map<string, Set<string>>();
  for (const [item, names] of [...pairs].sort()) {
    for (const name of [...names].sort()) {
      const std = resolve(name);
      if (!std) {
        if (!missing.has(name)) missing.set(name, new Set());
        missing.get(name)!.add(item);
        continue;
      }
      if (!dry) {
        await db`
          insert into public.scope_term
            (term, term_key, standard_id, source, evidence, confidence, review_status, reviewed_by)
          values (
            ${item}, public.scope_term_key(${item}), ${std.id}, 'EXPERT',
            ${`사고조사 건별 결함조사 항목 목록화(담당자 작성) — "${item}" → ${name}`},
            1, 'approved', '사고조사 담당자'
          )
          on conflict (term_key, standard_id) do update
            set source = 'EXPERT', review_status = 'approved',
                evidence = excluded.evidence, confidence = 1
        `;
      }
      inserted++;
    }
  }

  console.log(`엑셀 품목 ${pairs.size}종`);
  console.log(`사전에 넣은 대응 ${inserted}건${dry ? ' (dry — 저장하지 않음)' : ''}`);
  console.log('');
  console.log('우리 DB 에 없어서 못 넣은 기준:');
  for (const [name, items] of [...missing].sort()) {
    console.log(`  ${name.padEnd(26)} ← ${[...items].join(', ')}`);
  }
  console.log('');
  console.log('  이 품목들이 "못 찾는" 이유는 검색 실패가 아니라 기준 미적재입니다.');
  console.log('  해당 기준 JSON 을 KC안전기준/ 에 넣고 npm run standards:sync 를 돌리면 풀립니다.');
  await closeDb();
}

main().catch((e) => { console.error('실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
