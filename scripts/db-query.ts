/**
 * 읽기 전용 조회 — "코드는 있는데 데이터가 차 있나"를 재는 도구 (CLAUDE.md §16 6단계)
 *
 *   npm run db:query -- "select count(*) from public.case_event"
 *
 * 왜 따로 두는가 (2026-10-07)
 *   기능이 있다는 것과 데이터가 차 있다는 것은 다르다. 안전기준 GPC 판정이 5/76 이었고,
 *   리콜 품목은 등록 품목 칸만 보면 40건이지만 자동 판정까지 보면 2,081건이었다. 이런
 *   수치를 설계 전에 재야 헛짚지 않는다. 세션마다 임시 스크립트를 만들던 것을 저장소에 둔다.
 *
 * SELECT·WITH 로 시작하는 문장만 받고, 읽기 전용 트랜잭션 안에서 돌린다 — WITH 안에
 * update 를 숨겨도 DB 가 거절한다.
 */
import postgres from 'postgres';
import { required } from '../src/lib/env';

async function main() {
  const q = process.argv.slice(2).join(' ').trim();
  if (!/^(select|with)\b/i.test(q)) {
    console.error('SELECT 또는 WITH 로 시작하는 조회만 받습니다.');
    process.exit(1);
  }
  const sql = postgres(required('DATABASE_URL'), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql.begin('read only', (tx) => tx.unsafe(q));
    console.log(JSON.stringify(rows, null, 1));
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error('실패:', e instanceof Error ? e.message : e);
  process.exit(1);
});
