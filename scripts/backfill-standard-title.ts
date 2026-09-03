/**
 * 기준의 한글 명칭 채우기
 *
 *   npm run standards:title            채우고 결과 요약
 *   npm run standards:title -- --dry   무엇이 채워질지만 보여 주고 저장하지 않음
 *
 * 왜 별도 스크립트인가
 *   적재(standards:load)는 이미 끝나 76건이 DB 에 있다. 명칭 하나를 위해 전량을
 *   다시 적재하면 조항·태깅·임베딩이 전부 새로 만들어져 비용도 들고 위험하다.
 *   원본 JSON 은 저장소에 그대로 있으므로 명칭만 읽어 채운다.
 *
 * 원본 JSON 과 DB 를 무엇으로 맞추는가
 *   standard.source_filename 이 파일명을 그대로 갖고 있어 그것으로 잇는다.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, closeDb } from '../src/lib/db';
import { extractTitleKo } from '../src/lib/standards/title';

const FOLDER = join(import.meta.dirname, '..', 'KC안전기준');

async function main() {
  const dry = process.argv.includes('--dry');
  const db = getDb();

  const rows = await db<{ id: number; source_filename: string; display_name: string; title_ko: string | null }[]>`
    select id, source_filename, display_name, title_ko
    from public.standard where is_current
    order by id
  `;
  console.log(`대상 기준 : ${rows.length}건`);

  const files = new Set(readdirSync(FOLDER).filter((f) => f.endsWith('.json')));

  let filled = 0;
  let missing = 0;
  const noFile: string[] = [];

  for (const r of rows) {
    if (!files.has(r.source_filename)) {
      noFile.push(r.source_filename);
      continue;
    }

    const json = JSON.parse(readFileSync(join(FOLDER, r.source_filename), 'utf8'));
    const ocr: string = json?.result?.content?.ocr?.text ?? '';
    const title = extractTitleKo(ocr);

    if (!title) {
      missing++;
      console.log(`  명칭 못 찾음 : ${r.display_name}`);
      continue;
    }

    if (!dry) {
      await db`update public.standard set title_ko = ${title} where id = ${r.id}`;
    }
    filled++;
    if (filled <= 10 || dry) {
      console.log(`  ${r.display_name.slice(0, 34).padEnd(36)} → ${title.slice(0, 80)}`);
    }
  }

  console.log('');
  console.log(`${dry ? '채울 수 있는 건수' : '채운 건수'} : ${filled}건 / 명칭 못 찾음 ${missing}건`);
  if (noFile.length) {
    console.log(`원본 JSON 이 폴더에 없는 기준 ${noFile.length}건 — 건너뜀`);
    for (const f of noFile.slice(0, 5)) console.log(`  ${f}`);
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
