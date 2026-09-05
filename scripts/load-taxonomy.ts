/**
 * 법정 품목 ↔ GPC 대응표 적재
 *
 *   npm run taxonomy:load
 *   npm run taxonomy:load -- --file "docs/GPC 용어/….xlsx"
 *
 * 협회가 준 「품목별 세분류 매칭 DB」를 넣는다. 로직은 src/lib/taxonomy/load.ts 에 있다.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/lib/db';
import { loadTaxonomy } from '../src/lib/taxonomy/load';

const DIR = join(import.meta.dirname, '..', 'docs', 'GPC 용어');

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const explicit = argValue('--file');
  const path = explicit ?? (() => {
    const found = readdirSync(DIR).filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$'));
    if (found.length === 0) throw new Error(`${DIR} 에 xlsx 가 없습니다.`);
    return join(DIR, found[0]);
  })();

  console.log(`읽는 중: ${path}`);
  const r = await loadTaxonomy(path);

  console.log('');
  console.log(`적재 ${r.rows.toLocaleString()}행 · 법정 품목 ${r.items}종 · GPC 브릭 ${r.bricks}종`);

  if (r.unknownBricks.length > 0) {
    console.log('');
    console.log(`주의: 우리 GPC 목록에 없는 브릭 ${r.unknownBricks.length}종이 있습니다.`);
    console.log(`  ${r.unknownBricks.slice(0, 10).join(', ')}${r.unknownBricks.length > 10 ? ' …' : ''}`);
    console.log('  대응은 담겼지만 그 브릭의 이름·정의는 조회되지 않습니다. npm run gpc:load 로 갱신하세요.');
  }

  // 사고·리콜이 이 표로 실제로 이어지는지 바로 보여 준다
  const db = getDb();
  const [hit] = await db<{ terms: string; matched: string }[]>`
    select
      (select count(distinct term_key)::text from public.scope_term) terms,
      (select count(distinct t.term_key)::text
         from public.scope_term t
         join public.product_taxonomy p
           on public.scope_term_key(p.item) = t.term_key
           or public.scope_term_key(coalesce(p.sub_item, '')) = t.term_key
           or public.scope_term_key(coalesce(p.sub_sub_item, '')) = t.term_key) matched
  `;
  console.log('');
  console.log(`용어 사전 ${hit.terms}종 중 이 표의 법정 품목명과 맞는 것 ${hit.matched}종`);
  console.log('나머지는 일상어 ↔ 법정어 간극입니다 — 사전과 LLM 제안이 메울 자리입니다(04-2).');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
