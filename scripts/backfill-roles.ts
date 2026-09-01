/**
 * clause_role 채우기 (v0.7 §5.3)
 *
 *   npm run standards:roles           전체
 *   npm run standards:roles -- --dry  분포만 보고 쓰지 않는다
 *
 * 이미 적재된 13,501 조항에 역할을 매긴다. 파일을 다시 파싱하지 않고 DB 만 읽어
 * 갱신하므로 빠르다. 분류 규칙은 src/lib/standards/clause-role.ts 한 곳에만 있고,
 * 적재기(load.ts)와 이 스크립트가 같은 함수를 쓴다 — SQL 로 규칙을 복제하면
 * 나중에 한쪽만 고치게 된다(CLAUDE.md §9).
 */

import { getDb, closeDb } from '../src/lib/db';
import { classifyClause, type ClauseRole } from '../src/lib/standards/clause-role';

interface Row {
  id: number;
  standard_id: number;
  marker: string;
  part: string | null;
  level_code: string | null;
  title_raw: string | null;
  body: string;
}

/** 조항이 속한 최상위 절의 키. 부가 다르면 다른 절이다 */
function rootKey(r: { standard_id: number; part: string | null; marker: string }): string {
  return `${r.standard_id}|${r.part ?? ''}|${r.marker.split('.')[0]}`;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const db = getDb();

  const rows = await db<Row[]>`
    select id, standard_id, marker, part, level_code, title_raw, body
    from public.clause
    order by standard_id, order_index
  `;
  console.log(`조항 ${rows.length.toLocaleString()}건 분류 중...`);

  // 최상위 절의 제목을 먼저 모은다. 하위 조항은 이 제목으로 역할을 물려받는다.
  const rootTitle = new Map<string, string>();
  for (const r of rows) {
    if (r.marker.includes('.')) continue;
    rootTitle.set(rootKey(r), r.title_raw?.trim() || r.body.slice(0, 30));
  }

  const byRole = new Map<ClauseRole, number[]>();
  for (const r of rows) {
    const role = classifyClause({
      levelCode: r.level_code,
      rootTitle: rootTitle.get(rootKey(r)) ?? null,
    });
    const list = byRole.get(role) ?? [];
    list.push(r.id);
    byRole.set(role, list);
  }

  console.log('\n역할 분포');
  for (const [role, ids] of [...byRole].sort((a, b) => b[1].length - a[1].length)) {
    const pct = ((ids.length / rows.length) * 100).toFixed(1);
    console.log(`  ${role.padEnd(12)} ${String(ids.length).padStart(6)}  ${pct}%`);
  }

  if (dry) {
    console.log('\n(--dry) 저장하지 않고 종료합니다.');
    return;
  }

  for (const [role, ids] of byRole) {
    // id 목록을 통째로 넘기면 매개변수 한도에 걸리므로 나눠 넣는다
    for (let i = 0; i < ids.length; i += 5000) {
      const chunk = ids.slice(i, i + 5000);
      await db`update public.clause set clause_role = ${role} where id = any (${chunk}::bigint[])`;
    }
  }

  const [check] = await db<{ tagged_non_req: number }[]>`
    select count(*)::int as tagged_non_req
    from public.clause_tag t join public.clause c on c.id = t.clause_id
    where c.clause_role <> 'REQUIREMENT'
  `;
  console.log('\n저장 완료.');
  if (check.tagged_non_req > 0) {
    console.log(
      `주의: 요건이 아닌 조항에 이미 붙은 태그가 ${check.tagged_non_req}건 있습니다.\n` +
        '      역할 구분 전에 태깅한 것이므로 지우고 다시 붙이는 편이 낫습니다:\n' +
        "      delete from public.clause_tag t using public.clause c" +
        " where c.id = t.clause_id and c.clause_role <> 'REQUIREMENT';",
    );
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
