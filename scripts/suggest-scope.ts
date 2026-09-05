/**
 * 품목 확정이 안 된 사건에 적용 기준을 LLM 으로 제안한다
 *
 *   npm run scope:suggest              막힌 사건 전부, 보기만 한다
 *   npm run scope:suggest -- --save    제안을 용어 사전에 담는다(미검수 상태)
 *   npm run scope:suggest -- --item "LED등기구"   품목명 하나만
 *
 * 담는다고 바로 쓰이지 않는다. 담당자가 /terms 에서 확정해야 검색에 반영된다.
 * 로직은 src/lib/cases/suggest-scope.ts 에 있다 — 화면도 같은 함수를 쓸 수 있다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { standardsForCase } from '../src/lib/cases/resolve-scope';
import { suggestScope, saveSuggestions } from '../src/lib/cases/suggest-scope';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const save = process.argv.includes('--save');
  const only = argValue('--item');
  const db = getDb();

  // 품목명별로 모은다. 같은 "LED등기구"가 5건이면 한 번만 물어보면 된다
  const targets = new Map<string, number[]>();

  if (only) {
    targets.set(only, []);
  } else {
    const cases = await db<{ id: number; item_name: string | null }[]>`
      select id, item_name from public.case_event
      where source_type = 'ACCIDENT' order by id
    `;
    /*
      정규화한 키로 묶는다. "LED등기구"와 "LED 등기구"는 사전에서 같은 용어인데
      (scope_term_key 가 공백을 지운다) 표기가 달라 따로 물으면 호출이 두 배가 된다.
      다듬는 규칙은 DB 함수 하나에만 둔다 — 여기서 따로 흉내 내면 언젠가 어긋난다.
    */
    const seen = new Map<string, string>();
    for (const c of cases) {
      const ids = await standardsForCase(c.id);
      if (ids.length) continue;
      if (!c.item_name?.trim()) continue; // 품목명 자체가 없으면 물어볼 재료가 없다
      const raw = c.item_name.trim();
      const [{ key }] = await db<{ key: string }[]>`select public.scope_term_key(${raw}) as key`;
      const label = seen.get(key) ?? raw;
      seen.set(key, label);
      targets.set(label, [...(targets.get(label) ?? []), c.id]);
    }
  }

  if (targets.size === 0) {
    console.log('적용 기준을 못 찾은 사건이 없습니다.');
    return;
  }

  console.log(`품목 ${targets.size}종에 대해 물어봅니다.${save ? ' (제안을 사전에 담습니다)' : ' (보기만 합니다)'}\n`);

  let savedTotal = 0;
  for (const [itemName, caseIds] of targets) {
    const [ev] = caseIds.length
      ? await db<{ narrative: string }[]>`select narrative from public.case_event where id = ${caseIds[0]}`
      : [];

    const out = await suggestScope(itemName, ev?.narrative ?? null);
    const where = caseIds.length ? ` (사건 ${caseIds.join(', ')})` : '';
    console.log(`■ ${itemName}${where}`);

    if (out.none) {
      console.log(`   제안 없음 — ${out.note}`);
    } else {
      for (const s of out.suggestions) {
        console.log(`   ${s.standardName.padEnd(30)} 확신 ${(s.confidence * 100).toFixed(0)}%  ${s.reason}`);
      }
      if (out.note) console.log(`   메모: ${out.note}`);
      if (save) {
        const n = await saveSuggestions(itemName, out.suggestions);
        savedTotal += n;
        console.log(`   → 사전에 ${n}줄 담았습니다(미검수)`);
      }
    }
    console.log('');
  }

  if (save) {
    console.log(`모두 ${savedTotal}줄을 담았습니다.`);
    console.log('/terms 화면에서 확정해야 검색에 반영됩니다 — 품목이 틀리면 엉뚱한 기준의 시험이 나옵니다.');
  } else {
    console.log('담으려면 --save 를 붙여 다시 실행하세요.');
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
