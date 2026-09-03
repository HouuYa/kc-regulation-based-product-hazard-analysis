/**
 * 임베딩 자동 배치가 돌고 있는지 확인한다
 *
 *   npm run embed:status
 *
 * 자동 배치(supabase/migrations/020_embed_background.sql)는 DB 안에서 조용히 돌기
 * 때문에, 돌지 않아도 화면에 아무 표시가 나지 않는다. 그 상태를 사람이 눈으로
 * 확인할 수 있는 창구가 이 스크립트다. 보는 곳은 세 군데다.
 *
 *   1) public.embed_status   지금 몇 건이 비어 있고 몇 건이 발송 중인가
 *   2) cron.job              1분 주기가 등록돼 활성인가
 *   3) cron.job_run_details  최근 실행이 성공했는가 (실패하면 여기에만 남는다)
 */

import { getDb, closeDb } from '../src/lib/db';

interface StatusRow {
  target_table: string;
  total: number;
  embedded: number;
  pending: number;
  models: number;
  in_flight: number;
  failed: number;
  parked: number;
}

async function main() {
  const db = getDb();

  const rows = await db<StatusRow[]>`select * from public.embed_status order by target_table`;
  const LABEL: Record<string, string> = {
    clause: 'KC기준 조항',
    accident: '사고보고서',
    recall: '리콜',
  };

  console.log('=== 의미 검색 준비 현황 ===');
  for (const r of rows) {
    console.log(
      `${(LABEL[r.target_table] ?? r.target_table).padEnd(12)} 전체 ${String(r.total).padStart(6)} / 완료 ${String(r.embedded).padStart(6)}` +
        ` / 대기 ${String(r.pending).padStart(5)} / 발송중 ${String(r.in_flight).padStart(4)}` +
        ` / 실패 ${String(r.failed).padStart(4)} / 보류 ${String(r.parked).padStart(4)}`,
    );
    if (r.models > 1) {
      console.warn(`  경고: ${LABEL[r.target_table] ?? r.target_table} 에 의미 검색 기준(모델)이 ${r.models}종 섞여 있습니다. 검색 결과를 신뢰할 수 없습니다.`);
    }
  }

  const jobs = await db<{ jobname: string; schedule: string; active: boolean }[]>`
    select jobname, schedule, active from cron.job where jobname = 'embed-tick'
  `;
  console.log('');
  console.log('=== cron 등록 ===');
  if (jobs.length === 0) {
    console.warn('  embed-tick 이 등록돼 있지 않습니다. npm run db:push 를 실행하세요.');
  } else {
    console.log(`  ${jobs[0].jobname}  ${jobs[0].schedule}  ${jobs[0].active ? '활성' : '비활성'}`);
  }

  const runs = await db<{ start_time: string; status: string; return_message: string }[]>`
    select d.start_time, d.status, coalesce(d.return_message, '') as return_message
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
    where j.jobname = 'embed-tick'
    order by d.start_time desc
    limit 5
  `;
  console.log('');
  console.log('=== 최근 실행 5회 ===');
  if (runs.length === 0) {
    console.log('  아직 실행 기록이 없습니다(등록 직후라면 1분 안에 생깁니다).');
  }
  for (const r of runs) {
    console.log(`  ${new Date(r.start_time).toLocaleString('ko-KR')}  ${r.status.padEnd(9)} ${r.return_message.slice(0, 120)}`);
  }

  // 보류된 건은 사람이 봐야 한다 — 5회를 채웠다는 것은 재시도로 풀리지 않는다는 뜻이다
  const parked = await db<{ target_table: string; row_id: number; attempts: number; last_error: string }[]>`
    select target_table, row_id, attempts, coalesce(last_error, '') as last_error
    from public.embed_queue
    where status = 'failed' and attempts >= 5
    order by target_table, row_id
    limit 20
  `;
  if (parked.length > 0) {
    console.log('');
    console.log('=== 보류된 건 (재시도로 풀리지 않음) ===');
    for (const p of parked) {
      console.log(`  ${p.target_table} #${p.row_id} (${p.attempts}회) ${p.last_error.slice(0, 140)}`);
    }
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
