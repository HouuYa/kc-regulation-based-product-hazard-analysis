/**
 * 법정 품목 → 기준 잇기 채점 — 이미 이어져 있는 것을 정답지로 쓴다
 *
 *   npm run link:eval               30종으로 채점
 *   npm run link:eval -- --limit 60
 *
 * 정답지가 어디서 오나
 *   부속서 기준 33종 중 32종은 파일에 품목명(item_name)이 적혀 있어, 법정 품목과
 *   **글자로 이미 이어져 있다.** 그것을 정답으로 삼는다.
 *
 *   채점할 때는 그 이어짐을 **모델에게 알려 주지 않는다.** 적용범위와 제목만 보고
 *   맞히게 한 뒤, 정답과 견준다. 별칭 채점(eval-alias.ts)과 같은 방식이다.
 *
 * 무엇을 재나
 *   맞힘      정답 기준을 골랐다
 *   틀림      다른 기준을 골랐다        ← 가장 나쁘다. 엉뚱한 시험이 근거로 나간다
 *   못 고름   NONE 을 골랐다            ← 아쉽지만 안전하다
 *
 *   틀린 것과 못 고른 것을 나누는 이유는, 이 체계에서 **틀리는 것이 안 고르는 것보다
 *   훨씬 나쁘기** 때문이다(v0.7 §3.2). 정확도 하나로 뭉뚱그리면 그 차이가 사라진다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { suggestLinks, BATCH, type LinkTarget } from '../src/lib/taxonomy/link-standards';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const limit = Number(argValue('--limit') ?? '30');
  const db = getDb();

  // 정답지 — 기준의 품목명과 법정 품목명이 글자로 맞는 짝
  const gold = await db<{
    item_group: string; item: string | null; sub_item: string | null;
    standard_id: number; display_name: string; hint: string | null;
  }[]>`
    select distinct
      t.item_group, t.item, t.sub_item,
      s.id standard_id, s.display_name,
      array_to_string((array_agg(distinct t.brick_title)
        filter (where t.brick_title is not null))[1:3], ' · ') hint
    from public.product_taxonomy t
    join public.standard s
      on s.is_current and s.item_name is not null
     and public.scope_term_key(s.item_name) in (
           public.scope_term_key(t.item),
           public.scope_term_key(coalesce(t.sub_item, '')),
           public.scope_term_key(coalesce(t.sub_sub_item, '')))
    group by t.item_group, t.item, t.sub_item, s.id, s.display_name
    order by t.item_group, t.item, t.sub_item
    limit ${limit}
  `;

  if (gold.length === 0) {
    console.log('정답지가 없습니다. npm run taxonomy:load 를 먼저 돌리세요.');
    return;
  }
  console.log(`정답이 있는 품목 ${gold.length}종으로 채점합니다 (이어짐을 가리고 물어봅니다)\n`);

  const answer = new Map(
    gold.map((g) => [`${g.item_group}|${g.sub_item ?? g.item ?? ''}`, g]),
  );
  const targets: LinkTarget[] = gold.map((g) => ({
    itemGroup: g.item_group, item: g.item, subItem: g.sub_item, hint: g.hint || null,
  }));

  let hit = 0, wrong = 0, none = 0;
  const wrongList: string[] = [];
  const noneList: string[] = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const { suggestions, declined } = await suggestLinks(chunk);

    for (const s of suggestions) {
      const name = s.target.subItem || s.target.item || '';
      const g = answer.get(`${s.target.itemGroup}|${name}`);
      if (!g) continue;
      if (Number(g.standard_id) === Number(s.standardId)) hit++;
      else {
        wrong++;
        wrongList.push(`${name}: 정답 ${g.display_name} / 고른 것 ${s.standardName} (확신 ${(s.confidence * 100).toFixed(0)}%)`);
      }
    }
    for (const d of declined) {
      const name = d.target.subItem || d.target.item || '';
      const g = answer.get(`${d.target.itemGroup}|${name}`);
      if (!g) continue;
      none++;
      noneList.push(`${name}: 정답 ${g.display_name} — ${d.reason.slice(0, 60)}`);
    }
    console.log(`  ${Math.min(i + BATCH, targets.length)}/${targets.length} …`);
  }

  const total = hit + wrong + none;
  console.log('\n=== 채점 ===');
  console.log(`정답이 있는 ${total}종 중`);
  console.log(`  맞힘     ${hit}종 (${total ? (hit / total * 100).toFixed(1) : '0'}%)`);
  console.log(`  틀림     ${wrong}종 (${total ? (wrong / total * 100).toFixed(1) : '0'}%)  ← 엉뚱한 시험이 근거로 나간다`);
  console.log(`  못 고름  ${none}종 (${total ? (none / total * 100).toFixed(1) : '0'}%)  ← 아쉽지만 안전하다`);

  if (wrongList.length) {
    console.log('\n틀린 것 (가장 눈여겨볼 것)');
    wrongList.slice(0, 10).forEach((x) => console.log('  ' + x));
  }
  if (noneList.length) {
    console.log('\n못 고른 것');
    noneList.slice(0, 6).forEach((x) => console.log('  ' + x));
  }

  console.log('');
  console.log('판단 기준');
  console.log('  틀림이 많으면 쓰면 안 됩니다 — 담당자가 검수해도 그럴듯한 오답은 걸러내기 어렵습니다.');
  console.log('  못 고름이 많은 것은 덜 나쁩니다. 담당자가 채우면 됩니다.');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
