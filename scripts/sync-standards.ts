/**
 * 안전기준 폴더 동기화 CLI — src/lib/standards/sync.ts 를 커맨드라인에서 돌린다
 *
 *   npm run standards:sync                  KC안전기준/ 전체를 감지·비교
 *   npm run standards:sync -- --only "부속서 8"
 *
 * npm run standards:load 와 다른 점: load 는 해시만 보고 "있으면 건너뜀"이지만,
 * sync 는 표시명이 같은 기준의 해시가 달라지면 개정으로 보고 옛 판을 내리며
 * 새 판을 넣는다. 협회가 같은 부속서를 개정해 새 JSON 을 내려 줄 때 이 명령을 쓴다.
 */

import { closeDb } from '../src/lib/db';
import { syncStandardsFolder } from '../src/lib/standards/sync';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const LABEL: Record<string, string> = {
  new: '신규',
  updated: '개정',
  unchanged: '동일',
  error: '실패',
};

async function main() {
  const only = argValue('--only') ?? undefined;
  const results = await syncStandardsFolder({ only });

  const counts = { new: 0, updated: 0, unchanged: 0, error: 0 };
  for (const r of results) counts[r.status]++;

  for (const r of results) {
    if (r.status === 'unchanged') continue; // 조용히 넘어간다 — 대부분은 동일할 것이다
    const label = LABEL[r.status];
    if (r.status === 'error') {
      console.error(`${label}  ${r.file}: ${r.message}`);
    } else {
      console.log(
        `${label}  ${r.displayName}` +
          (r.status === 'updated' ? ` (이전 standard_id=${r.previousStandardId} → 내림)` : ''),
      );
      if (r.clauseCount != null) {
        console.log(`        조항 ${r.clauseCount} · 시험방법 연결 ${r.testMethodLinkCount}`);
      }
    }
  }

  console.log('');
  console.log(
    `신규 ${counts.new} · 개정 ${counts.updated} · 동일 ${counts.unchanged} · 실패 ${counts.error} ` +
      `(전체 ${results.length}건)`,
  );

  if (counts.updated > 0) {
    console.log('');
    console.log('개정된 기준의 조항은 아직 태깅되지 않았습니다. npm run tag 로 재태깅하세요.');
  }
  if (counts.error > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
