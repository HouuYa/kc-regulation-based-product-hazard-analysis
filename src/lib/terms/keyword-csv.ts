/**
 * 별칭 사전 내보내기·가져오기
 *
 * 담당자는 엑셀로 일한다. 화면에서 한 줄씩 고치는 것보다 내려받아 한꺼번에 손보고
 * 되돌려 넣는 쪽이 훨씬 빠르다 — 그 길이 없으면 이 사전은 결국 안 쓰인다.
 *
 * 조용히 바뀌면 안 된다
 *   사전이 바뀌면 어떤 품목으로 인식되는지가 바뀌고, 그러면 붙는 기준이 바뀐다.
 *   그래서 무엇이 새로 들어오고 무엇이 바뀌는지 먼저 보여 준 뒤에만 적용한다.
 *
 * 지우지 않는다
 *   파일에 없는 줄은 건드리지 않는다. 담당자가 일부만 잘라 온 파일을 올렸을 때
 *   사전이 통째로 날아가면 안 된다. 지우는 것은 화면에서 하나씩 한다.
 */

import { getDb } from '../db';
import { toCsv, cell } from '../csv';

const HEADER = ['품목군', '품목', '세부품목', '검색어', '출처', '검수상태', '확신도', '근거'] as const;

const SOURCE_KO: Record<string, string> = { EXPERT: '담당자', LLM: 'AI 제안' };
const STATUS_KO: Record<string, string> = {
  approved: '확정', auto_unreviewed: '미검수', rejected: '반려',
};
const SOURCE_EN = Object.fromEntries(Object.entries(SOURCE_KO).map(([k, v]) => [v, k]));
const STATUS_EN = Object.fromEntries(Object.entries(STATUS_KO).map(([k, v]) => [v, k]));

export async function exportKeywordsCsv(): Promise<string> {
  const rows = await getDb()<{
    item_group: string; item: string | null; sub_item: string | null;
    keyword: string; source: string; review_status: string;
    confidence: string | null; evidence: string | null;
  }[]>`
    select item_group, item, sub_item, keyword, source, review_status,
           confidence::text, evidence
    from public.item_keyword
    order by item_group, coalesce(sub_item, item), source, keyword
  `;

  return toCsv(HEADER, rows.map((r) => [
    r.item_group, r.item ?? '', r.sub_item ?? '', r.keyword,
    SOURCE_KO[r.source] ?? r.source,
    STATUS_KO[r.review_status] ?? r.review_status,
    r.confidence ? Number(r.confidence).toFixed(2) : '',
    r.evidence ?? '',
  ]));
}

/* ── 가져오기 ──────────────────────────────────────────────────────────── */

/** 아주 작은 CSV 파서 — 따옴표 안의 쉼표와 이스케이프된 따옴표만 다룬다 */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((v) => v.trim()));
}

export interface KeywordPreviewRow {
  itemGroup: string;
  item: string | null;
  subItem: string | null;
  keyword: string;
  source: string;
  reviewStatus: string;
  /** 새로 들어옴 / 상태가 바뀜 / 그대로 */
  change: '추가' | '상태 바뀜' | '그대로';
  before?: string;
}

async function readRows(csv: string): Promise<KeywordPreviewRow[]> {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];

  // 머리글이 있으면 건너뛴다
  const start = (rows[0][0] ?? '').trim() === '품목군' ? 1 : 0;
  const out: KeywordPreviewRow[] = [];

  for (const r of rows.slice(start)) {
    const [group, item, sub, keyword, source, status] = r.map((v) => (v ?? '').trim());
    if (!group || !keyword) continue;
    out.push({
      itemGroup: group,
      item: item || null,
      subItem: sub || null,
      keyword,
      source: SOURCE_EN[source] ?? (source === 'EXPERT' || source === 'LLM' ? source : 'EXPERT'),
      reviewStatus: STATUS_EN[status] ?? (status || 'approved'),
    } as KeywordPreviewRow);
  }
  return out;
}

/** 올린 파일이 지금 사전과 무엇이 다른지 보여 준다. 저장하지 않는다 */
export async function previewKeywordsCsv(csv: string): Promise<KeywordPreviewRow[]> {
  const db = getDb();
  const rows = await readRows(csv);
  const out: KeywordPreviewRow[] = [];

  for (const r of rows) {
    const [found] = await db<{ source: string; review_status: string }[]>`
      select source, review_status from public.item_keyword
      where keyword_key = public.scope_term_key(${r.keyword})
        and item_group = ${r.itemGroup}
        and coalesce(sub_item, '') = ${r.subItem ?? ''}
        and coalesce(item, '') = ${r.item ?? ''}
      limit 1
    `;
    if (!found) out.push({ ...r, change: '추가' });
    else if (found.review_status !== r.reviewStatus) {
      out.push({
        ...r, change: '상태 바뀜',
        before: `${SOURCE_KO[found.source] ?? found.source} · ${STATUS_KO[found.review_status] ?? found.review_status}`,
      });
    } else out.push({ ...r, change: '그대로' });
  }
  return out;
}

/** 미리보기에서 본 그대로 반영한다 */
export async function applyKeywordsCsv(csv: string): Promise<number> {
  const db = getDb();
  const rows = await readRows(csv);
  let changed = 0;

  for (const r of rows) {
    const [res] = await db<{ id: number }[]>`
      insert into public.item_keyword
        (item_group, item, sub_item, keyword, keyword_key, source, review_status)
      values (${r.itemGroup}, ${r.item}, ${r.subItem}, ${r.keyword},
              public.scope_term_key(${r.keyword}), ${r.source}, ${r.reviewStatus})
      on conflict (keyword_key, item_group, coalesce(sub_item, ''), coalesce(item, ''))
      do update set review_status = excluded.review_status
      where public.item_keyword.review_status is distinct from excluded.review_status
      returning id
    `;
    if (res) changed++;
  }
  return changed;
}

/** 화면에서 쓰는 표기 — 한 곳에만 둔다 */
export const KEYWORD_LABEL = { source: SOURCE_KO, status: STATUS_KO };

/** CSV 한 칸을 만드는 규칙이 화면 미리보기와 어긋나지 않게 함께 내보낸다 */
export { cell };
