/**
 * 사고사진을 variant B(측정값·부품구성 확장)로 다시 분석한다 (라운드 72)
 *
 *   npm run photos:reanalyze -- --all           증거 사진이 있는 사고보고서 전부
 *   npm run photos:reanalyze -- --case 5556     한 건만
 *   npm run photos:reanalyze -- --all --limit 5 앞 5건만 (비용 가늠용)
 *
 * variant A 로 이미 분석된 사진도 다시 돈다(forceReanalyze) — 그래야 같은
 * 사진에서 A/B 차이를 견줄 수 있다. 로직은 src/lib/cases/process-photos.ts 에
 * 있다. 이 파일은 인자 파싱과 출력뿐이다(CLAUDE.md §9).
 */

import { getDb, closeDb } from '../src/lib/db';
import { analyzeStoredPhotos } from '../src/lib/cases/process-photos';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const db = getDb();
  const one = arg('--case');
  const limit = Number(arg('--limit') ?? '0');

  let files: Array<{ source_file_id: number; case_id: number; item_name: string | null; title: string | null }>;

  if (one) {
    const rows = await db<{ source_file_id: number | null; item_name: string | null; title: string | null }[]>`
      select source_file_id, item_name, title from public.case_event where id = ${Number(one)}
    `;
    if (!rows[0]?.source_file_id) {
      console.log('이 사건에는 사진이 없습니다.');
      await closeDb();
      return;
    }
    files = [{ source_file_id: rows[0].source_file_id, case_id: Number(one), item_name: rows[0].item_name, title: rows[0].title }];
  } else if (process.argv.includes('--all')) {
    const rows = await db<{ source_file_id: number; case_id: number; item_name: string | null; title: string | null }[]>`
      select distinct on (e.source_file_id)
        e.source_file_id, e.id as case_id, e.item_name, e.title
      from public.case_event e
      join public.source_file_image i on i.source_file_id = e.source_file_id
      where e.source_type = 'ACCIDENT' and i.is_relevant_photo
      order by e.source_file_id, e.id
    `;
    files = rows;
    if (limit > 0) files = files.slice(0, limit);
  } else {
    console.log('--case <id> 또는 --all 이 필요합니다.');
    await closeDb();
    return;
  }

  console.log(`증거 사진이 있는 보고서 ${files.length}건을 variant B로 재분석합니다.`);
  let ok = 0;
  for (const f of files) {
    try {
      const r = await analyzeStoredPhotos(
        db, f.source_file_id, { itemName: f.item_name, title: f.title },
        { variant: 'B', forceReanalyze: true },
      );
      console.log(`  사건 ${f.case_id} (source_file ${f.source_file_id}) — 사진 ${r.analyzed}장 재분석`);
      ok++;
    } catch (e) {
      console.error(`  사건 ${f.case_id} 실패:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`완료 — ${ok}/${files.length}건`);
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
