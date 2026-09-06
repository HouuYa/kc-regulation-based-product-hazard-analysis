/**
 * 담당자 별칭 사전 적재 — 「일일동향보고 검색용 데이터」
 *
 *   npm run keywords:load
 *   npm run keywords:load -- --file "docs/GPC 용어/….xlsx"
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/lib/db';
import { loadItemKeywords } from '../src/lib/terms/keyword-load';

const DIR = join(import.meta.dirname, '..', 'docs', 'GPC 용어');

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const path = argValue('--file') ?? (() => {
    const f = readdirSync(DIR).find((x) => x.includes('일일동향') && x.endsWith('.xlsx'));
    if (!f) throw new Error(`${DIR} 에 「일일동향보고 검색용 데이터」가 없습니다.`);
    return join(DIR, f);
  })();

  console.log(`읽는 중: ${path}`);
  const r = await loadItemKeywords(path);

  console.log('');
  console.log(`별칭 ${r.keywords}개 · 가리키는 품목 ${r.targets}종 · 검색 제외어 ${r.stopwords}개`);
  console.log(`정의문·머리글로 보고 건너뛴 칸 ${r.skipped}개`);

  const db = getDb();
  const cover = await db<{ label: string; n: string }[]>`
    select '사고보고서' label, count(*)::text n from (
      select distinct ce.item_name from public.case_event ce
      join public.item_keyword k on k.keyword_key = public.scope_term_key(ce.item_name)
      where ce.source_type = 'ACCIDENT') x
    union all
    select '해외 리콜', count(*)::text from (
      select distinct ce.item_name from public.case_event ce
      join public.item_keyword k on k.keyword_key = public.scope_term_key(ce.item_name)
      where ce.source_type = 'RECALL_OVERSEAS') y
  `;
  console.log('');
  console.log('이 사전으로 곧바로 이어지는 품목명');
  for (const c of cover) console.log(`  ${c.label}  ${c.n}종`);
  console.log('');
  console.log('나머지는 AI 가 별칭을 보태고, 그 품질은 npm run alias:eval 로 잽니다.');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
