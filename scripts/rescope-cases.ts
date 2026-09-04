/**
 * 품목이 확정되지 않은 사건에 품목 확정을 다시 돌린다
 *
 *   npm run cases:rescope
 *   npm run cases:rescope -- --dry
 *
 * 왜 따로 두는가
 *   cases:code 는 코드 부여까지 함께 한다. 코드는 이미 붙어 있는데 품목만 없는
 *   사건에 그것을 다시 돌리면 AI 를 이유 없이 다시 부른다. 품목 확정 방법이
 *   나아졌을 때(적용범위 의미 검색 추가) 그 부분만 다시 돌리기 위한 것이다.
 */
import { getDb, closeDb } from '../src/lib/db';
import { resolveProductScope } from '../src/lib/cases/resolve-scope';
import { extractItemName } from '../src/lib/cases/item-name';

async function main() {
  const dry = process.argv.includes('--dry');
  const db = getDb();

  const rows = await db<{ id: number; title: string; narrative: string; item_name: string | null; extracted_text: string | null }[]>`
    select e.id, e.title, e.narrative, e.item_name, f.extracted_text
    from public.case_event e
    left join public.source_file f on f.id = e.source_file_id
    where e.source_type = 'ACCIDENT' and e.product_scope_id is null
      -- 용어 사전(042)이 생겼으므로, 의미 검색으로 붙인 것도 다시 본다.
      -- 담당자가 확정한 대응이 있으면 그쪽이 맞다
      and (e.scope_evidence is null or e.scope_evidence like '적용범위 의미 검색%')
    order by e.id
  `;
  console.log(`품목 미확정 사건 ${rows.length}건${dry ? ' (dry)' : ''}\n`);

  let ok = 0, no = 0;
  for (const c of rows) {
    const itemName = c.item_name ?? extractItemName(c.extracted_text ?? '');
    if (!itemName) { no++; console.log(`  [${c.id}] 품목명을 못 뽑음`); continue; }
    const scope = await resolveProductScope(itemName, c.narrative);
    if (!scope) { no++; console.log(`  [${c.id}] "${itemName}" → 못 찾음`); continue; }
    ok++;
    console.log(`  [${c.id}] "${itemName}" → ${scope.method} · 기준 ${scope.standardCount}종`);
    console.log(`         ${scope.evidence.slice(0, 150)}`);
    if (!dry) {
      await db`
        update public.case_event
        set product_scope_id = ${scope.productScopeId}, scope_evidence = ${scope.evidence},
            item_name = coalesce(item_name, ${itemName})
        where id = ${c.id}
      `;
    }
  }
  console.log(`\n확정 ${ok} / 미확정 ${no} / 전체 ${rows.length}`);
  await closeDb();
}
main().catch((e) => { console.error('실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
