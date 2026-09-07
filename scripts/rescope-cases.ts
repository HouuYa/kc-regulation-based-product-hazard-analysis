/**
 * 품목이 확정되지 않은 사건에 품목 확정을 다시 돌린다
 *
 *   npm run cases:rescope
 *   npm run cases:rescope -- --dry
 *   npm run cases:rescope -- --source-type RECALL_OVERSEAS --no-llm
 *   npm run cases:rescope -- --source-type RECALL_OVERSEAS --limit 30
 *   npm run cases:rescope -- --redo "적용범위 원문 검색" --limit 30   이미 붙은 것 다시 보기
 *
 * 왜 따로 두는가
 *   cases:code 는 코드 부여까지 함께 한다. 코드는 이미 붙어 있는데 품목만 없는
 *   사건에 그것을 다시 돌리면 AI 를 이유 없이 다시 부른다. 품목 확정 방법이
 *   나아졌을 때(적용범위 의미 검색 추가) 그 부분만 다시 돌리기 위한 것이다.
 *
 * 리콜이 빠져 있었다 (2026-09-07)
 *   `source_type = 'ACCIDENT'` 로 박혀 있어 리콜은 이 배치에 아예 들어오지
 *   못했다. 그런데 정작 이 배치가 필요한 쪽이 리콜이었다 —
 *
 *     RECALL_OVERSEAS  2,299건   품목명 2,299 · 코드 2,299 · 품목 확정 40
 *
 *   품목명도 코드도 다 있는데 품목만 40건 붙어 있는, 정확히 이 배치가 고치라고
 *   만들어진 상태였다. `resolveProductScope()` 는 이미 리콜에도 쓰는 함수다
 *   (최초 코드화 때 tag-cases.ts 가 --source-type RECALL_OVERSEAS 로 부른다).
 *   막고 있던 것은 이 필터 하나뿐이었다.
 *
 * --no-llm 을 왜 두는가
 *   값싼 경로(사전·검색어·품목명·전문검색)가 모두 빗나가면 의미 검색이 임베딩과
 *   LLM 을 부르고, 붙으면 scope_term 에 미검수로 쌓는다. 한 건이면 알맞지만
 *   2,299건이면 이야기가 다르다 — 비용도 비용이고, 검수 대기가 이미 병목인데
 *   (검색어 4,943개) 거기에 수천 건을 더 얹는다. 그래서 먼저 값싼 경로만 돌려
 *   이득을 재고, LLM 은 그 숫자를 보고 따로 결정한다.
 */
import { getDb, closeDb } from '../src/lib/db';
import { resolveProductScope } from '../src/lib/cases/resolve-scope';
import { extractItemName } from '../src/lib/cases/item-name';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const noLlm = process.argv.includes('--no-llm');
  const sourceType = argValue('--source-type');
  const limit = argValue('--limit') ? Number(argValue('--limit')) : null;
  const db = getDb();

  /*
    이미 붙어 있는 것도 다시 볼 수 있어야 한다 (--redo, 2026-09-07)

    품목 확정 방법이 나아지면 예전 방식으로 붙은 것은 낡은 답이 된다. 실제로
    원문검색을 「구 먼저」로 고치자 표본에서 붙는 기준이 83종 → 10종으로 줄었다
    ("안전 조끼"에 전기다리미가 붙어 있었다). 그 1,406건을 그대로 두면 담당자가
    낡은 답을 근거로 검토하게 된다.

    근거를 지우고 다시 돌리는 방법도 있지만 그러지 않는다 — 지우면 "전에 무엇으로
    붙었는지"가 사라져 나아졌는지 나빠졌는지 견줄 수 없다. 대신 어느 방법으로 붙은
    것을 다시 볼지 골라서 태운다.
  */
  const redo = argValue('--redo');
  const rows = await db<{ id: number; title: string; narrative: string; item_name: string | null; extracted_text: string | null }[]>`
    select e.id, e.title, e.narrative, e.item_name, f.extracted_text
    from public.case_event e
    left join public.source_file f on f.id = e.source_file_id
    where e.product_scope_id is null
      ${sourceType ? db`and e.source_type = ${sourceType}` : db``}
      ${redo
        // 지정한 방법으로 붙은 것만 다시 본다 (예: --redo "적용범위 원문 검색")
        ? db`and e.scope_evidence like ${redo + '%'}`
        // 기본은 아직 못 붙인 것과, 의미 검색으로 붙인 것.
        // 용어 사전(042)이 생겼으므로 담당자가 확정한 대응이 있으면 그쪽이 맞다
        : db`and (e.scope_evidence is null or e.scope_evidence like '적용범위 의미 검색%')`}
    order by e.id
    ${limit ? db`limit ${limit}` : db``}
  `;
  console.log(
    `${redo ? `「${redo}」 으로 붙은 사건` : '품목 미확정 사건'} ${rows.length}건` +
    `${sourceType ? ` (${sourceType})` : ''}${noLlm ? ' · 의미 검색 끔' : ''}${dry ? ' · dry' : ''}\n`,
  );

  let ok = 0, no = 0;
  // 어느 경로가 붙였는지 센다. "얼마나 붙었나"보다 "무엇이 붙였나"가 다음 판단을 정한다
  const byMethod = new Map<string, number>();

  for (const c of rows) {
    const itemName = c.item_name ?? extractItemName(c.extracted_text ?? '');
    if (!itemName) { no++; console.log(`  [${c.id}] 품목명을 못 뽑음`); continue; }
    const scope = await resolveProductScope(itemName, c.narrative, { allowSemantic: !noLlm });
    if (!scope) {
      no++;
      /*
        다시 보는 중(--redo)에 못 찾았으면 예전 답을 지운다.

        지우지 않으면 "안전 조끼 → 전기다리미" 같은 낡은 답이 그대로 남아, 고친
        뒤에도 담당자가 그것을 근거로 검토하게 된다. 못 찾은 것은 못 찾았다고
        보이는 편이 맞다 — 이 체계에서 틀린 답은 빈칸보다 나쁘다.
      */
      if (redo && !dry) {
        await db`
          update public.case_event
          set product_scope_id = null, scope_evidence = null
          where id = ${c.id}
        `;
        console.log(`  [${c.id}] "${itemName}" → 못 찾음 · 예전 답을 지웠다`);
      }
      continue;
    }
    ok++;
    byMethod.set(scope.method, (byMethod.get(scope.method) ?? 0) + 1);
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
  for (const [method, n] of [...byMethod].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${method.padEnd(16)} ${n}`);
  }
  await closeDb();
}
main().catch((e) => { console.error('실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
