/**
 * AI 별칭 채점 — 사람이 만든 사전을 정답지로 쓴다
 *
 *   npm run alias:eval                 20종으로 채점
 *   npm run alias:eval -- --limit 60   더 많이
 *
 * 어떻게 재나
 *   담당자가 「전선」에 붙인 별칭 6개를 **AI 에게 보여 주지 않고** 만들게 한 뒤,
 *   몇 개를 맞혔는지 센다. 정답이 있는 채점이다.
 *
 *   두 가지를 함께 본다.
 *     재현율   사람이 적은 별칭 중 AI 가 맞힌 비율   — 사람만큼 떠올리는가
 *     새 제안   사람이 안 적었는데 AI 가 낸 것        — 사전을 넓히는가
 *
 *   새 제안이 쓸모 있는지는 **실제 리콜 품목명에 걸리는지**로 확인한다.
 *   아무도 안 쓰는 말을 지어냈다면 리콜에 하나도 안 걸린다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { aliasTargets, suggestAliases, BATCH } from '../src/lib/terms/alias';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const norm = (s: string) => s.replace(/\([^)]*\)/g, '').replace(/[\s·\-_/]/g, '').toLowerCase();

async function main() {
  const limit = Number(argValue('--limit') ?? '20');
  const db = getDb();

  // 사람이 별칭을 붙인 품목만 고른다 — 정답이 있는 것들이다
  const targets = await aliasTargets({ onlyMissing: false, limit });
  if (targets.length === 0) {
    console.log('채점할 대상이 없습니다. 먼저 npm run keywords:load 를 돌리세요.');
    return;
  }
  console.log(`품목 ${targets.length}종으로 채점합니다 (사람 사전을 가리고 물어봅니다)\n`);

  // 실제로 쓰이는 말인지 확인할 실물 — 해외 리콜 품목명
  const recalls = await db<{ item_name: string }[]>`
    select distinct item_name from public.case_event
    where source_type = 'RECALL_OVERSEAS' and item_name is not null`;
  const recallKeys = new Set(recalls.map((r) => norm(r.item_name)));

  let hit = 0, expected = 0, extra = 0, extraUsed = 0;
  const samples: string[] = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const out = await suggestAliases(chunk);

    for (const s of out) {
      const name = s.target.subItem || s.target.item || '';
      const gold = await db<{ keyword: string }[]>`
        select keyword from public.item_keyword
        where source = 'EXPERT' and item_group = ${s.target.itemGroup}
          and coalesce(sub_item, item, '') = ${s.target.subItem ?? s.target.item ?? ''}
      `;
      const goldKeys = new Set(gold.map((g) => norm(g.keyword)));
      if (goldKeys.size === 0) continue;

      const mine = new Set(s.keywords.map(norm));
      const matched = [...mine].filter((k) => goldKeys.has(k));
      const newOnes = [...mine].filter((k) => !goldKeys.has(k));
      // 사람이 안 적었지만 실제 리콜 품목명에 걸리는 것 — 사전이 넓어진 증거다
      const newUsed = newOnes.filter((k) => [...recallKeys].some((r) => r === k || r.includes(k)));

      hit += matched.length; expected += goldKeys.size;
      extra += newOnes.length; extraUsed += newUsed.length;

      if (samples.length < 6) {
        samples.push(
          `  ${name}\n` +
          `    사람: ${gold.map((g) => g.keyword).join(', ')}\n` +
          `    AI  : ${s.keywords.join(', ')}\n` +
          `    맞힘 ${matched.length}/${goldKeys.size} · 새 제안 ${newOnes.length}개(리콜에 걸리는 것 ${newUsed.length}개)`,
        );
      }
    }
    console.log(`  ${Math.min(i + BATCH, targets.length)}/${targets.length} …`);
  }

  console.log('\n=== 채점 ===');
  console.log(`사람이 적은 별칭 ${expected}개 중 AI 가 맞힌 것 ${hit}개 — 재현율 ${expected ? (hit / expected * 100).toFixed(1) : '0'}%`);
  console.log(`사람이 안 적은 새 제안 ${extra}개 · 그중 실제 리콜 품목명에 걸리는 것 ${extraUsed}개`);
  console.log('');
  console.log('보기');
  console.log(samples.join('\n'));
  console.log('');
  console.log('판단 기준');
  console.log('  재현율이 낮으면 사람만큼 떠올리지 못하는 것이고,');
  console.log('  새 제안이 리콜에 안 걸리면 아무도 안 쓰는 말을 지어낸 것입니다.');
  console.log('  둘이 함께 좋아야 채택합니다.');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
