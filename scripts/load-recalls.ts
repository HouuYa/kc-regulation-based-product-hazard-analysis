/**
 * 해외 리콜 적재 — 트랙 B 의 입구
 *
 *   npm run recalls:fetch                         승인된 전체
 *   npm run recalls:fetch -- --source EU --limit 50
 *   npm run recalls:fetch -- --stats               출처별 현황만
 *
 * 적재 로직은 src/lib/recall/load.ts 에 있다
 *   담당자 요청으로 이 수집이 하루 1회 자동 실행되면서, 명령줄과 자동 실행이 같은
 *   로직을 쓰게 됐다. 두 곳에 복사해 두면 원본 표 스키마가 바뀔 때 한쪽만 고치게
 *   된다(CLAUDE.md §9). 여기서는 인자 해석과 출력만 맡는다.
 */

import { closeDb } from '../src/lib/db';
import { fetchApprovedStats } from '../src/lib/recall/source';
import { loadRecalls } from '../src/lib/recall/load';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  if (process.argv.includes('--stats')) {
    const stats = await fetchApprovedStats();
    const total = stats.reduce((s, r) => s + r.count, 0);
    console.log(`해외 리콜 승인 건 전체 ${total.toLocaleString()}건`);
    for (const s of stats) console.log(`  ${s.source.padEnd(16)}${String(s.count).padStart(5)}건`);
    return;
  }

  const source = argValue('--source') ?? undefined;
  const limit = argValue('--limit') ? Number(argValue('--limit')) : undefined;

  console.log(`원본 표 조회 : ${[source && `출처 ${source}`, limit && `최대 ${limit}건`].filter(Boolean).join(' · ') || '승인된 전체'}`);

  const r = await loadRecalls({ source, limit });
  console.log(`받은 건수     : ${r.received}`);
  if (r.received === 0) return;

  for (const w of r.warnings) console.warn(`  경고: ${w}`);

  console.log('');
  console.log(`캐시 저장       : ${r.cached}건`);
  console.log(`사건 행         : 신규 ${r.newCase}건 / 기존 ${r.existingCase}건`);
  console.log(`품목 확정       : ${r.resolved}건`);
  console.log(`코드화          : ${r.tagged}건 (관리자값 ${r.tagged - r.llmReclassified.length} · LLM 재분류 ${r.llmReclassified.length})`);
  console.log(`KC 기준 대조    : ${r.withStd}건 — 공고에 명시된 위반 표준이 우리 기준과 번호가 같은 경우`);
  if (r.droppedCodes > 0) {
    console.log(`코드북에 없어 버린 부코드 : ${r.droppedCodes}개 (주코드는 LLM이 재분류했으므로 부코드만 버려짐)`);
  }
  if (r.llmReclassified.length > 0) {
    console.log('');
    console.log(`LLM 재분류(관리자 코드가 코드북에 없어 대체) : ${r.llmReclassified.length}건 — review_status='auto_unreviewed'로 검수 대상`);
    for (const u of r.llmReclassified.slice(0, 20)) {
      console.log(`  recall_cache#${u.cacheId} ${u.source}:${u.guid}  ${u.from} → ${u.to}`);
    }
    if (r.llmReclassified.length > 20) console.log(`  ... 외 ${r.llmReclassified.length - 20}건`);
  }
  if (r.unclassified.length > 0) {
    console.log('');
    console.log(`미분류(LLM 재분류도 실패) : ${r.unclassified.length}건 — 담당자 확인 필요`);
    for (const u of r.unclassified.slice(0, 20)) {
      console.log(`  recall_cache#${u.cacheId} ${u.source}:${u.guid}  HF=${u.hf ?? '(없음)'} DT=${u.dt ?? '(없음)'}`);
    }
    if (r.unclassified.length > 20) console.log(`  ... 외 ${r.unclassified.length - 20}건`);
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
