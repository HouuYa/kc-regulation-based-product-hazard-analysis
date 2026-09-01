/**
 * 안전기준 파싱 JSON → DB 적재 (전량/부분 최초 적재용 CLI)
 *
 *   npm run standards:load                          KC안전기준/ 전체
 *   npm run standards:load -- --only "부속서 8"       파일명에 포함된 것만
 *   npm run standards:load -- --force               이미 적재된 것도 다시 넣는다
 *
 * 새 파일이 추가돼 "이미 있는 기준의 개정판인지" 를 판단해야 하는 경우는
 * 이 스크립트가 아니라 npm run standards:sync 를 쓴다(src/lib/standards/sync.ts).
 * 여기서는 해시로만 판별하는 단순한 최초 적재만 한다 — 전량을 처음 밀어 넣을 때는
 * 그걸로 충분하고, 매번 표시명 조회를 거칠 이유가 없다.
 *
 * 삽입 로직은 src/lib/standards/load.ts 를 공유한다. standards:sync 도 같은 함수를
 * 쓰므로, 스키마가 바뀌어도 한 곳만 고치면 된다.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, closeDb } from '../src/lib/db';
import { parseStandardJson } from '../src/lib/standards/parse-result-json';
import { insertParsedStandard } from '../src/lib/standards/load';
import { listStandardFiles, STANDARDS_DIR } from './inspect-standards';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function loadOne(file: string, force: boolean): Promise<string> {
  const raw = readFileSync(join(STANDARDS_DIR, file), 'utf8');
  const p = parseStandardJson(file, raw);
  const db = getDb();

  const existing = await db<{ id: number }[]>`
    select id from public.standard where source_sha256 = ${p.meta.source_sha256}
  `;
  if (existing.length > 0 && !force) {
    return `건너뜀   ${p.meta.display_name} (이미 적재됨)`;
  }

  const result = await db.begin(async (tx) => {
    if (existing.length > 0) {
      // --force: 조항·연결·시험조건은 cascade 로 함께 지워진다
      await tx`delete from public.standard where id = ${existing[0].id}`;
    }
    return insertParsedStandard(tx, p);
  });

  return (
    `적재 완료 ${p.meta.display_name}\n` +
    `           조항 ${result.clauseCount} · 시험조건 ${result.testConditionCount} · ` +
    `연결 ${result.linkCount}(시험방법 ${result.testMethodLinkCount})`
  );
}

async function main() {
  const only = argValue('--only');
  const force = process.argv.includes('--force');

  const files = listStandardFiles().filter((f) => (only ? f.includes(only) : true));
  if (files.length === 0) {
    throw new Error(only ? `"${only}" 를 포함하는 파일이 없습니다.` : 'KC안전기준/ 에 JSON 이 없습니다.');
  }

  console.log(`${files.length}개 기준 적재 시작\n`);
  let ok = 0;
  const failures: string[] = [];

  for (const f of files) {
    try {
      console.log(await loadOne(f, force));
      ok++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 한 건이 실패해도 나머지는 진행한다 (§8.1 다건 처리 규칙과 같은 원칙)
      console.error(`실패     ${f}: ${msg}`);
      failures.push(f);
    }
  }

  console.log('');
  console.log(`완료 ${ok}/${files.length}건`);
  if (failures.length) {
    console.log('실패 목록:');
    for (const f of failures) console.log('  -', f);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
