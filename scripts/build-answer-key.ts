/**
 * 엑셀(사고조사 건별 결함조사 항목) → §5.8 전문가 정답셋
 *
 *   npm run eval:build-key
 *
 * 왜 이 엑셀이 정답지로 쓸 수 있는가 (v0.7 §0.2)
 *   §0.2 는 review_log(시스템 결과를 보고 남긴 검토 기록)를 정답지로 쓰는 것을
 *   평가 설계 오류로 지목했다 — 시스템이 제시하지 않은 조항은 정답에 들어갈 수
 *   없어 재현율이 늘 부풀려지기 때문이다.
 *
 *   이 엑셀은 그 문제가 없다. 담당자가 사고조사 과정에서 "이 사고면 어느 조항의
 *   시험을 의뢰하겠는가"를 적은 것이고, 우리 시스템과 무관하게 만들어졌다.
 *   즉 §5.8 이 요구하는 바로 그 자료다.
 *
 * 조항을 (기준 표시명, 조항번호)로 지목하는 이유는 eval.ts 주석에 있다 —
 * clause id 는 재적재하면 바뀌지만 조항번호는 기준이 개정되기 전까지 그대로다.
 *
 * 왜 xlsx 라이브러리를 들이지 않았는가
 *   xlsx 는 zip 안의 XML 이다. 이 파일 하나를 읽자고 의존성을 늘릴 이유가 없고,
 *   늘리면 그것도 계속 관리해야 한다. 필요한 만큼만 직접 푼다.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { getDb, closeDb } from '../src/lib/db';

const ROOT = join(import.meta.dirname, '..');
const XLSX = join(ROOT, '사고조사보고서', '__사고조사 건별 결함조사 항목 목록화_전달용.xlsx');
const OUT = join(ROOT, 'docs', 'eval', 'answer-key.json');

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

function unescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function readSheet(): string[][] {
  const buf = readFileSync(XLSX);
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

/* ── 표기 정리 ─────────────────────────────────────────────────────────── */

/** 엑셀이 "4.1" 을 4.0999999999999996 으로 저장한다. 원래 표기로 되돌린다 */
function cleanMarker(raw: string): string {
  const s = (raw ?? '').trim();
  if (!/^\d+\.\d{6,}$/.test(s)) return s;
  return String(Number(Number(s).toFixed(4)));
}

/** ★ 를 뗀 접수번호 비교용 키. PDF 파일명과 엑셀의 ★ 표기가 어긋나는 건이 있다 */
const accKey = (s: string) => s.replace(/★/g, '').replace(/\s+/g, '').trim();

async function main() {
  const db = getDb();
  const data = readSheet().slice(2).filter((r) => (r[1] ?? '').trim());

  const stds = await db<{ id: number; display_name: string }[]>`
    select id, display_name from public.standard where is_current
  `;
  const exact = new Map(stds.map((s) => [s.display_name.trim(), s]));
  const annexIdx = new Map<string, string>();
  for (const s of stds) {
    const m = s.display_name.match(/^(안전확인|안전인증|공급자적합성|안전기준준수)\s*부속서\s*(\d+)/);
    if (m) annexIdx.set(`${m[1]} 부속서 ${m[2]}`, s.display_name);
  }

  function resolveStandard(raw: string): string | null {
    const s = raw.trim();
    if (exact.has(s)) return s;
    // 엑셀은 "생활용품/어린이제품" 접두어를 붙이고 품목명을 뺀다
    const annex = s.replace(/^(생활용품|어린이제품)\s*/, '');
    const m = annex.match(/^(안전확인|안전인증|공급자적합성|안전기준준수)\s*부속서\s*(\d+)/);
    if (m) return annexIdx.get(`${m[1]} 부속서 ${m[2]}`) ?? null;
    /*
      KC 60335-98 → KC 60335-2-98 보정.

      -1 은 절대 보정하지 않는다. IEC 계열의 "-1" 은 공통부이고 실재하는 문서다.
      KC 60598-1(등기구 공통부)을 KC 60598-2-1(개별부)로 잇는 것은 다른 문서를
      잇는 일이다 — crosswalk.ts 가 같은 이유로 못박아 둔 규칙이다.
      실제로 이 보정을 처음 쓸 때 그 실수를 했고, 절 번호가 안 맞아 드러났다.
    */
    const k = s.match(/^KC\s*(\d{5})-(\d+)$/);
    if (k && k[2] !== '1') {
      const alt = `KC ${k[1]}-2-${k[2]}`;
      if (exact.has(alt)) return alt;
    }
    return null;
  }

  // 사건 제목이 곧 PDF 파일명이다
  const cases = await db<{ id: number; title: string }[]>`
    select id, title from public.case_event where source_type = 'ACCIDENT'
  `;
  const caseByAcc = new Map<string, number>();
  for (const c of cases) {
    const m = (c.title ?? '').match(/^\((\d\d)\)(\d+)/);
    if (m) caseByAcc.set(accKey(`(${m[1]})${m[2]}`), c.id);
  }

  interface Expected { standard: string; marker: string; part?: string }
  const byCase = new Map<string, { expected: Expected[]; skipped: string[]; items: Set<string> }>();

  for (const r of data) {
    const key = accKey((r[1] ?? '').trim());
    const e = byCase.get(key) ?? { expected: [], skipped: [], items: new Set<string>() };
    byCase.set(key, e);

    const rawStd = (r[9] ?? '').trim();
    const marker = cleanMarker(r[11] ?? '');
    const item = (r[12] ?? '').trim();
    if (item) e.items.add(item);

    if (!rawStd || rawStd === '-' || !marker || marker === '-') {
      e.skipped.push(`${rawStd || '표준없음'}/${marker || '절없음'}${item ? `(${item})` : ''}`);
      continue;
    }
    const std = resolveStandard(rawStd);
    if (!std) {
      e.skipped.push(`${rawStd}/${marker}${item ? `(${item})` : ''} — 우리 DB 에 없는 기준`);
      continue;
    }
    const part = (r[10] ?? '').trim();
    const one: Expected = { standard: std, marker };
    if (part && part !== '-') one.part = part;
    if (!e.expected.some((x) => x.standard === one.standard && x.marker === one.marker)) {
      e.expected.push(one);
    }
  }

  const out = {
    _설명: [
      '§5.8 정확도 측정용 전문가 정답셋.',
      '출처: 사고조사보고서/__사고조사 건별 결함조사 항목 목록화_전달용.xlsx',
      '담당자가 사고조사 과정에서 정한 시험항목이며, 우리 시스템 결과와 무관하게 작성됐다.',
      'npm run eval:build-key 로 다시 만든다. 손으로 고치면 다음 실행에 덮어써진다.',
    ],
    cases: [] as Array<Record<string, unknown>>,
  };

  let noCase = 0, expectedTotal = 0, skippedTotal = 0;
  const noCaseKeys: string[] = [];
  for (const [key, v] of [...byCase].sort()) {
    const caseId = caseByAcc.get(key);
    if (!caseId) { noCase++; noCaseKeys.push(key); continue; }
    skippedTotal += v.skipped.length;
    if (v.expected.length === 0) continue;
    expectedTotal += v.expected.length;
    out.cases.push({
      caseId,
      note: [
        `접수 ${key}`,
        v.items.size ? `시험항목: ${[...v.items].join(', ')}` : '',
        v.skipped.length ? `정답에서 뺀 것 ${v.skipped.length}건 — ${v.skipped.join(' / ')}` : '',
      ].filter(Boolean).join(' · '),
      expected: v.expected,
    });
  }

  mkdirSync(join(ROOT, 'docs', 'eval'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

  console.log(`엑셀 자료 행           ${data.length}`);
  console.log(`사고 건수(접수번호)     ${byCase.size}`);
  console.log(`정답셋에 담긴 사건      ${out.cases.length}`);
  console.log(`  기대 조항            ${expectedTotal}건`);
  console.log(`  정답에서 뺀 항목      ${skippedTotal}건 (우리 DB 에 없는 기준·표준 미기재)`);
  console.log(`사건을 못 찾은 접수번호  ${noCase}건 ${noCaseKeys.join(', ')}`);
  console.log('');
  console.log(`작성: ${OUT}`);
  await closeDb();
}

main().catch((e) => {
  console.error('실패:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
