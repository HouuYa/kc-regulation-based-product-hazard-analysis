/**
 * 결과에서 원인으로 가는 다리를 만든다 (04-1 문서)
 *
 *   npm run cause:build
 *   npm run cause:build -- --min-support 3
 *   npm run cause:build -- --show DT.THERMAL.FIRE
 *
 * 리콜 자료의 피해-원인 동시출현을 세어 codebook.cause_bridge 를 다시 만든다.
 * 계산은 src/lib/codebook/cause-bridge.ts 에 있다 — 화면도 같은 함수를 쓴다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { buildCauseBridge, estimateCauses, MIN_SUPPORT } from '../src/lib/codebook/cause-bridge';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const minSupport = Number(argValue('--min-support') ?? MIN_SUPPORT);
  const show = argValue('--show');

  const r = await buildCauseBridge(minSupport);

  console.log('');
  console.log(`사건 ${r.cases.toLocaleString()}건을 세어 ${r.rows}줄을 담았습니다.`);
  console.log(`근거 ${minSupport}건 미만이라 버린 줄 ${r.dropped}개.`);

  const db = getDb();
  const byRoute = await db<{ route: string; n: string }[]>`
    select r.route, count(*)::text n
    from codebook.cause_bridge b join codebook.hf_route r on r.code = b.hf_code
    group by r.route order by count(*) desc
  `;
  console.log('');
  console.log('확인 경로별 줄 수 (TEST 만 시험항목 도출에 쓰입니다)');
  for (const b of byRoute) console.log(`  ${b.route.padEnd(6)} ${b.n.padStart(4)}줄`);

  if (show) {
    console.log('');
    console.log(`${show} 의 원인 후보 (시험으로 확인 가능한 것만)`);
    console.log('  원인'.padEnd(34) + '근거      비율    리프트');
    console.log('  ' + '─'.repeat(60));
    for (const c of await estimateCauses([show])) {
      console.log(
        '  ' + `${c.nameKo ?? c.hfCode}`.padEnd(30),
        `${c.support}건`.padStart(6),
        `${(c.confidence * 100).toFixed(1)}%`.padStart(8),
        c.lift.toFixed(2).padStart(8),
      );
    }
  }

  console.log('');
  console.log('원인이 미상인 사고에서 이 표로 원인 후보를 좁힌 뒤 시험항목을 찾습니다.');
  console.log('효과는 `npm run eval -- --k 5` 의 「+ 원인 다리」 행으로 확인합니다.');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
