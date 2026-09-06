/**
 * 담당자가 만든 별칭 사전 적재 — 「일일동향보고 검색용 데이터」
 *
 * 이 파일이 왜 값어치가 큰가
 *   AI 로 별칭을 지어내려던 계획이 있었는데, 서랍에 이미 사전이 있었다. 그리고 이건
 *   지어낸 말이 아니라 **담당자가 실제로 검색에 쓰는 말**이다.
 *
 *   더 중요한 것은 이것이 **정답지 구실을 한다**는 점이다. 사람이 「전선」에 붙인
 *   별칭 6개를 가리고 AI 에게 만들게 한 뒤 몇 개를 맞히는지 재면, AI 별칭 생성의
 *   품질을 숫자로 판정할 수 있다(scripts/eval-alias.ts).
 *
 * 시트마다 모양이 다르다
 *   전기용품은 키워드가 8번째 열부터, 생활용품·어린이제품은 4번째 열부터 시작한다.
 *   머리글에서 "키워드" 열을 찾아 그 뒤를 전부 키워드로 읽는다 — 열 위치를 박아 두면
 *   개정판에서 어긋난다.
 *
 * 정의문이 섞여 들어온다
 *   어린이제품 시트의 품목 칸에는 기준 정의가 통째로 들어 있는 행이 있다(수천 자).
 *   길이로 거른다. 별칭은 길어야 서른 자다.
 */

import { getDb } from '../db';
import { readWorkbook, sheetByName, type Sheet } from '../xlsx';

/** 별칭으로 인정할 길이. 넘으면 정의문이 섞여 든 것이다 */
const MAX_KEYWORD = 30;

/** 시트 이름과 품목군 */
const SHEETS = ['전기용품', '생활용품', '어린이제품'] as const;

export interface KeywordLoadResult {
  keywords: number;
  targets: number;
  stopwords: number;
  /** 정의문·머리글로 보여 버린 칸 수 */
  skipped: number;
}

function keywordColumn(sheet: Sheet): number {
  // 머리글 줄은 시트마다 0행 또는 1행이다. "키워드"가 있는 줄을 찾는다
  for (const row of sheet.rows.slice(0, 3)) {
    const i = (row ?? []).findIndex((h) => (h ?? '').trim() === '키워드');
    if (i >= 0) return i;
  }
  throw new Error(`${sheet.name} 시트에 "키워드" 열이 없습니다.`);
}

function headerRow(sheet: Sheet): number {
  for (let i = 0; i < Math.min(3, sheet.rows.length); i++) {
    if ((sheet.rows[i] ?? []).some((h) => (h ?? '').trim() === '키워드')) return i;
  }
  return 0;
}

export async function loadItemKeywords(path: string): Promise<KeywordLoadResult> {
  const wb = readWorkbook(path);
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const db = getDb();

  interface Row { group: string; item: string | null; sub: string | null; keyword: string }
  const rows: Row[] = [];
  let skipped = 0;

  for (const name of SHEETS) {
    const sheet = sheetByName(wb, name);
    if (!sheet) continue;
    const kwCol = keywordColumn(sheet);
    const hdr = headerRow(sheet);
    const itemCol = kwCol >= 7 ? 1 : 1;   // 두 모양 모두 품목이 1열, 세부품목이 2열이다
    const subCol = 2;

    for (const r of sheet.rows.slice(hdr + 1)) {
      const item = (r[itemCol] ?? '').trim() || null;
      const sub = (r[subCol] ?? '').trim() || null;
      if (!item && !sub) continue;

      for (const raw of r.slice(kwCol)) {
        const k = (raw ?? '').trim();
        if (!k) continue;
        // "…키워드들" 같은 머리글 셀과 정의문을 거른다
        if (k.includes('키워드') || k.length < 2 || k.length > MAX_KEYWORD) { skipped++; continue; }
        rows.push({
          group: name,
          // 품목 칸에 기준 정의가 통째로 든 행이 있다. 지시 대상으로 쓸 수 없다
          item: item && item.length <= 60 ? item : null,
          sub: sub && sub.length <= 60 ? sub : null,
          keyword: k,
        });
      }
    }
  }

  const stop = sheetByName(wb, '일일동향보고 검색 제외어');
  const stopwords = new Set<string>();
  if (stop) {
    for (const r of stop.rows) {
      for (const v of r) {
        const w = (v ?? '').trim();
        if (w && w.length <= MAX_KEYWORD) stopwords.add(w);
      }
    }
  }

  /*
    사람이 만든 것만 지우고 다시 넣는다.

    AI 가 제안한 줄(source='LLM')과 담당자가 검수한 상태는 건드리지 않는다 —
    협회 파일을 다시 넣는다고 사람의 판단이 사라지면 안 된다.
  */
  await db.begin(async (tx) => {
    await tx`delete from public.item_keyword where source = 'EXPERT'`;
    for (const r of rows) {
      await tx`
        insert into public.item_keyword
          (item_group, item, sub_item, keyword, keyword_key, source, review_status, source_file)
        values (${r.group}, ${r.item}, ${r.sub}, ${r.keyword},
                public.scope_term_key(${r.keyword}), 'EXPERT', 'approved', ${fileName})
        on conflict do nothing
      `;
    }
    await tx`delete from public.item_keyword_stopword`;
    for (const w of stopwords) {
      await tx`
        insert into public.item_keyword_stopword (word, word_key, source_file)
        values (${w}, public.scope_term_key(${w}), ${fileName})
        on conflict (word) do nothing
      `;
    }
  });

  const [{ n: saved }] = await db<{ n: string }[]>`
    select count(*)::text n from public.item_keyword where source = 'EXPERT'
  `;
  const [{ n: targets }] = await db<{ n: string }[]>`
    select count(distinct coalesce(sub_item, item))::text n
    from public.item_keyword where source = 'EXPERT'
  `;

  return {
    keywords: Number(saved),
    targets: Number(targets),
    stopwords: stopwords.size,
    skipped,
  };
}
