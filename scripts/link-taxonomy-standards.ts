/**
 * 법정 품목 → KC안전기준 잇기
 *
 *   npm run taxonomy:link -- --group 전기용품            만들어 보기만 한다
 *   npm run taxonomy:link -- --group 전기용품 --save     담는다(미검수)
 *   npm run taxonomy:link -- --limit 20                 몇 개만
 *
 * 담는다고 바로 쓰이지 않는다. 담당자가 확정해야 품목 확정에 반영된다.
 * 로직은 src/lib/taxonomy/link-standards.ts 에 있다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { linkTargets, suggestLinks, saveLinks, saveDeclines, BATCH } from '../src/lib/taxonomy/link-standards';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** 이 품목이 실제 사고·리콜에 걸리는가 — 검수 우선순위의 근거 */
async function usageOf(group: string, target: string): Promise<number> {
  const [r] = await getDb()<{ n: string }[]>`
    select count(distinct ce.id)::text n
    from public.item_keyword k
    join public.case_event ce on public.scope_term_key(ce.item_name) = k.keyword_key
    where k.item_group = ${group} and coalesce(k.sub_item, k.item, '') = ${target}
      and k.review_status <> 'rejected' and ce.item_name is not null
  `;
  return Number(r.n);
}

async function main() {
  const save = process.argv.includes('--save');
  const group = argValue('--group') ?? undefined;
  const limit = argValue('--limit') ? Number(argValue('--limit')) : undefined;

  const targets = await linkTargets({ itemGroup: group, limit });
  if (targets.length === 0) {
    console.log('이을 품목이 없습니다. 이미 다 이어졌거나 조건에 맞는 품목이 없습니다.');
    return;
  }

  console.log(`법정 품목 ${targets.length}종을 기준에 이어 봅니다${group ? ` (${group})` : ''}.`);
  console.log(save ? '제안을 담습니다(미검수).' : '만들어 보기만 합니다 — 담으려면 --save.\n');

  let made = 0, saved = 0, none = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const { suggestions, declined } = await suggestLinks(chunk);
    made += suggestions.length;
    none += declined.length;

    for (const s of suggestions) {
      const name = s.target.subItem || s.target.item || '';
      const used = await usageOf(s.target.itemGroup, name);
      console.log(
        `  ${name.padEnd(22)} → ${s.standardName.padEnd(16)} 확신 ${(s.confidence * 100).toFixed(0)}%` +
        (used ? `  · 사고·리콜 ${used}건에 걸리는 품목` : ''),
      );
      console.log(`      ${s.evidence}`);
    }
    // 거절도 모두 보여 준다 — 담당자가 그 자리에서 바로잡거나, 적재해야 할 기준을 찾는 재료다
    for (const d of declined) {
      console.log(`  ${(d.target.subItem || d.target.item || '').padEnd(22)} → (이을 기준 없음) ${d.reason.slice(0, 90)}`);
    }

    if (save) { saved += await saveLinks(suggestions); saved += await saveDeclines(declined); }
    console.log(`  … ${Math.min(i + BATCH, targets.length)}/${targets.length}\n`);
  }

  console.log(`이은 것 ${made}건 · 고르지 않은 것 ${none}건${save ? ` · 담은 것 ${saved}건` : ''}`);
  if (save) {
    console.log('');
    console.log('/keywords 「법정 품목 → 기준」 에서 확정해야 품목 확정에 쓰입니다.');
    console.log('품목이 틀리면 엉뚱한 기준의 시험이 근거로 제시됩니다 — 조용히 틀리는 고장입니다.');
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
