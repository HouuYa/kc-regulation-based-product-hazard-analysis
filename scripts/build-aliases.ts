/**
 * AI 별칭 생성 — 사람 사전이 비워 둔 품목을 채운다
 *
 *   npm run alias:build                 만들어 보기만 한다
 *   npm run alias:build -- --save       사전에 담는다(미검수)
 *   npm run alias:build -- --limit 100  일부만
 *
 * 담는다고 바로 쓰이지 않는다. source='LLM' 이고 담당자가 확정해야 한다.
 * 품질은 npm run alias:eval 로 따로 잰다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { aliasTargets, suggestAliases, saveAliases, BATCH } from '../src/lib/terms/alias';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** 리콜 품목명 중 사전으로 이어지는 종수 — 사전이 넓어졌는지 재는 잣대 */
async function recallCoverage(): Promise<number> {
  const [{ n }] = await getDb()<{ n: string }[]>`
    select count(*)::text n from (
      select distinct ce.item_name from public.case_event ce
      join public.item_keyword k on k.keyword_key = public.scope_term_key(ce.item_name)
      where ce.source_type = 'RECALL_OVERSEAS' and k.review_status <> 'rejected') x
  `;
  return Number(n);
}

async function main() {
  const save = process.argv.includes('--save');
  const limit = argValue('--limit') ? Number(argValue('--limit')) : undefined;

  const before = await recallCoverage();
  const targets = await aliasTargets({ onlyMissing: true, limit });
  console.log(`사람 사전이 비워 둔 품목 ${targets.length}종에 검색어를 만듭니다.`);
  console.log(`${save ? '사전에 담습니다(미검수).' : '만들어 보기만 합니다 — 담으려면 --save.'}\n`);

  let made = 0, saved = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const out = await suggestAliases(chunk);
    made += out.reduce((s, o) => s + o.keywords.length, 0);
    if (save) saved += await saveAliases(out);

    for (const o of out.slice(0, 2)) {
      console.log(`  ${(o.target.subItem ?? o.target.item ?? '').padEnd(24)} ${o.keywords.slice(0, 8).join(', ')}`);
    }
    console.log(`  … ${Math.min(i + BATCH, targets.length)}/${targets.length}\n`);
  }

  console.log(`검색어 ${made}개 생성${save ? ` · ${saved}개 담음` : ''}`);

  if (save) {
    const after = await recallCoverage();
    console.log('');
    console.log(`해외 리콜 품목명 중 사전으로 이어지는 종수  ${before}종 → ${after}종 (+${after - before})`);
    console.log('담당자가 /terms 에서 확정하기 전에는 검색에 쓰이지 않습니다.');
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
