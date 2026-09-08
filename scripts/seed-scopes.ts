/**
 * 품목·적용기준 세트 구축 (v0.7 §3.2 · §5.1)
 *
 *   npm run scopes:seed          품목 등록 + 기준 연결 + 적용범위 원문 모으기
 *   npm run scopes:seed -- --dry 쓰지 않고 결과만 본다
 *
 * 하는 일 세 가지
 *   1) 각 기준의 적용범위(SCOPE) 조항 본문을 standard.scope_text 에 모은다.
 *      품목→기준 확정의 근거가 되고, 담당자에게 "왜 이 기준인가"를 문장으로 보인다.
 *   2) 이름이 붙은 기준(어린이제품 33건)으로 품목을 만들고 ANNEX 로 연결한다.
 *   3) 어린이제품 품목에 공통안전기준을 COMMON 으로 연결한다.
 *      유아용 의자 사고면 부속서 8 만으로 부족하고 공통안전기준을 함께 봐야 한다.
 *      어린이제품이 아닌 품목에는 걸지 않는다 — 이름이 붙은 기준 33종 중 16종이
 *      생활용품이다(053).
 *
 * 전기용품(KC 60335 계열 등)은 여기서 품목을 만들지 않는다.
 *   파일명에 품목이 없어 이름을 지어낼 수 없고, 지어내면 틀린 이름이 고정된다.
 *   대신 scope_text 전문검색으로 사건이 들어올 때 찾는다(resolve-scope.ts).
 *   찾은 뒤 담당자가 확인하면 그때 품목으로 등록하는 것이 순서다.
 */

import { getDb, closeDb } from '../src/lib/db';

async function main() {
  const dry = process.argv.includes('--dry');
  const db = getDb();

  // 1) 적용범위 원문 모으기
  const scopeRows = await db<{ standard_id: number; scope_text: string }[]>`
    select c.standard_id, string_agg(c.body, ' ' order by c.order_index) as scope_text
    from public.clause c
    where c.clause_role = 'SCOPE' and length(btrim(c.body)) > 20
    group by c.standard_id
  `;
  console.log(`적용범위 원문 : ${scopeRows.length}개 기준에서 수집`);

  if (!dry) {
    for (const r of scopeRows) {
      await db`update public.standard set scope_text = ${r.scope_text} where id = ${r.standard_id}`;
    }
  }

  // 2) 이름 있는 기준 → 품목
  const named = await db<{ id: number; item_name: string; display_name: string }[]>`
    select id, item_name, display_name from public.standard
    where is_current and item_name is not null and btrim(item_name) <> ''
    order by item_name
  `;
  const itemNames = [...new Set(named.map((s) => s.item_name))];
  console.log(`품목          : ${itemNames.length}개 (이름이 붙은 기준 ${named.length}건에서)`);

  // 3) 공통안전기준 찾기 — 어린이제품 전반에 함께 적용된다
  const commons = await db<{ id: number; display_name: string }[]>`
    select id, display_name from public.standard
    where is_current and display_name like '%공통안전기준%'
  `;
  console.log(`공통안전기준  : ${commons.length}건 — ${commons.map((c) => c.display_name).join(', ')}`);

  if (dry) {
    console.log('\n(--dry) 저장하지 않고 종료합니다.');
    console.log('품목 목록:', itemNames.join(', '));
    return;
  }

  let annexLinks = 0;
  let commonLinks = 0;
  let childScopes = 0;

  for (const name of itemNames) {
    /*
      품목군을 법정 품목 대응표로 판정한다 (2026-09-08)

      전에는 category 를 '어린이제품' 으로 박아 넣었다. 이름이 붙은 기준이
      어린이제품 부속서뿐이라고 본 것인데, 실제로는 33종 중 16종이 생활용품이다
      (가스라이터·우산 및 양산·디지털도어록·휴대용 예초기의 날 …). 그대로 두면
      아래에서 어린이제품 공통안전기준이 생활용품 품목에도 걸린다.

      여러 품목군에 걸리면 어린이제품으로 본다. 대응표에 아직 없는 품목은 이름으로
      보수적으로 판정한다 — 근거는 docs/제품안전법제도/어린이제품_공통안전기준.md.
    */
    const [g] = await db<{ category: string }[]>`
      select case
        when ${name} ~ '어린이|유아|아동'
          or exists (select 1 from public.product_taxonomy t
                     where t.item_group = '어린이제품'
                       and public.scope_term_key(${name}) in (
                             public.scope_term_key(t.item),
                             public.scope_term_key(t.sub_item),
                             public.scope_term_key(t.sub_sub_item)))
        then '어린이제품'
        else coalesce((select t.item_group from public.product_taxonomy t
                       where public.scope_term_key(${name}) in (
                               public.scope_term_key(t.item),
                               public.scope_term_key(t.sub_item),
                               public.scope_term_key(t.sub_sub_item))
                       limit 1), '기타')
      end as category
    `;
    const isChild = g.category === '어린이제품';
    if (isChild) childScopes++;

    const [scope] = await db<{ id: number }[]>`
      insert into public.product_scope (name, category)
      values (${name}, ${g.category})
      on conflict (name) do update set name = excluded.name, category = excluded.category
      returning id
    `;

    for (const s of named.filter((x) => x.item_name === name)) {
      const r = await db`
        insert into public.standard_applicability
          (product_scope_id, standard_id, relation, evidence)
        values (${scope.id}, ${s.id}, 'ANNEX', ${'기준 파일명의 품목 표기와 일치: ' + s.display_name})
        on conflict do nothing
      `;
      annexLinks += r.count;
    }

    // 공통안전기준은 어린이제품에만, 그리고 자기 자신에게는 걸지 않는다
    for (const c of commons) {
      if (!isChild) continue;
      if (named.some((x) => x.item_name === name && x.id === c.id)) continue;
      const r = await db`
        insert into public.standard_applicability
          (product_scope_id, standard_id, relation, evidence)
        values (${scope.id}, ${c.id}, 'COMMON',
                ${'어린이제품 공통안전기준은 부속서와 함께 적용된다(v0.7 3.2)'})
        on conflict do nothing
      `;
      commonLinks += r.count;
    }
  }

  const [n] = await db<{ scopes: number; links: number; withScope: number }[]>`
    select
      (select count(*)::int from public.product_scope) as scopes,
      (select count(*)::int from public.standard_applicability) as links,
      (select count(*)::int from public.standard where scope_text is not null) as "withScope"
  `;

  console.log('');
  console.log(`품목 ${n.scopes}개 (그중 어린이제품 ${childScopes}개) · 적용기준 연결 ${n.links}건 (신규 ANNEX ${annexLinks} / COMMON ${commonLinks})`);
  console.log(`적용범위 원문을 가진 기준 ${n.withScope}건`);
  console.log('');
  console.log('전기용품은 품목을 미리 만들지 않았습니다 — 사건이 들어올 때');
  console.log('적용범위 원문 검색으로 찾고, 담당자가 확인한 뒤 등록하는 것이 순서입니다.');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
