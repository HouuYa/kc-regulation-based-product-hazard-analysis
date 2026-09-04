import { getDb } from '../db';

/**
 * 용어 사전 내보내기·가져오기
 *
 * 왜 CSV 인가
 *   담당자는 실제로 엑셀로 일한다 — 이 프로젝트의 정답지도 엑셀로 받았다.
 *   화면에서 한 건씩 고치는 것보다 내려받아 한꺼번에 손보고 되돌려 넣는 쪽이
 *   훨씬 빠르다. 그 길이 없으면 이 사전은 결국 안 쓰이게 된다.
 *
 *   xlsx 가 아니라 CSV 인 이유는 엑셀이 CSV 를 그대로 열고, 우리 쪽에 쓰기
 *   라이브러리를 들이지 않아도 되기 때문이다.
 *
 * BOM 을 붙이는 이유
 *   엑셀은 BOM 이 없는 UTF-8 CSV 를 한글이 깨진 채로 연다. 담당자가 파일을
 *   열자마자 깨진 글자를 보면 그다음은 없다.
 *
 * 가져오기는 바로 적용하지 않는다
 *   사전이 바뀌면 검색 결과가 바뀐다. 조용히 바뀌는 것이 이 체계에서 가장 나쁜
 *   고장이라, 무엇이 새로 들어오고 무엇이 바뀌는지 먼저 보여 준 뒤에만 적용한다.
 */

export interface TermRow {
  term: string;
  standard: string;
  gpcBrick: string;
  gpcTitle: string;
  source: string;
  reviewStatus: string;
  evidence: string;
}

const HEADER = ['품목명', '적용기준', 'GPC코드', 'GPC품목군', '출처', '검수상태', '근거'] as const;

/** 쉼표·따옴표·줄바꿈이 든 값을 CSV 규칙대로 감싼다 */
function cell(v: string | null | undefined): string {
  const s = (v ?? '').replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportTermsCsv(): Promise<string> {
  const db = getDb();
  const rows = await db<TermRow[]>`
    select
      t.term                                as term,
      s.display_name                        as standard,
      coalesce(g.brick_code, '')            as "gpcBrick",
      coalesce(gb.brick_title_ko, gb.brick_title_en, '') as "gpcTitle",
      t.source                              as source,
      t.review_status                       as "reviewStatus",
      coalesce(t.evidence, '')              as evidence
    from public.scope_term t
    join public.standard s on s.id = t.standard_id
    left join public.scope_term_gpc g on g.term_key = t.term_key
    left join public.gpc_brick gb on gb.brick_code = g.brick_code
    where s.is_current
    order by t.term, s.display_name
  `;

  const lines = [HEADER.join(',')];
  for (const r of rows) {
    lines.push([
      cell(r.term), cell(r.standard), cell(r.gpcBrick), cell(r.gpcTitle),
      cell(r.source), cell(r.reviewStatus), cell(r.evidence),
    ].join(','));
  }
  // 엑셀이 한글을 제대로 열게 BOM 을 붙인다
  return `﻿${lines.join('\r\n')}\r\n`;
}

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
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((c) => c.trim()));
}

export type ChangeKind = '새로 추가' | '검수상태 바뀜' | '변화 없음' | '기준을 찾지 못함';

export interface PreviewRow {
  term: string;
  standard: string;
  reviewStatus: string;
  kind: ChangeKind;
  note?: string;
}

/**
 * 가져올 CSV 를 지금 사전과 견주어 무엇이 바뀌는지 만든다. 저장하지 않는다.
 *
 * 삭제는 하지 않는다 — CSV 에 없는 행을 지우면, 담당자가 일부만 잘라 온 파일을
 * 올렸을 때 사전이 통째로 날아간다. 지우는 것은 화면에서 하나씩 하게 둔다.
 */
export async function previewTermsCsv(text: string): Promise<PreviewRow[]> {
  const db = getDb();
  const rows = parseCsv(text);
  if (rows.length === 0) return [];

  const head = rows[0].map((h) => h.trim());
  const body = head[0] === HEADER[0] ? rows.slice(1) : rows;

  const stds = await db<{ display_name: string }[]>`
    select display_name from public.standard where is_current
  `;
  const known = new Set(stds.map((s) => s.display_name.trim()));

  const existing = await db<{ term_key: string; standard: string; review_status: string }[]>`
    select t.term_key, s.display_name as standard, t.review_status
    from public.scope_term t join public.standard s on s.id = t.standard_id
  `;
  const [{ key: keyFn }] = [{ key: (t: string) => t.replace(/\([^)]*\)/g, '').replace(/[\s·\-_/]/g, '').toLowerCase() }];
  const cur = new Map(existing.map((e) => [`${e.term_key}||${e.standard}`, e.review_status]));

  const out: PreviewRow[] = [];
  for (const r of body) {
    const term = (r[0] ?? '').trim();
    const standard = (r[1] ?? '').trim();
    const status = (r[5] ?? 'approved').trim() || 'approved';
    if (!term || !standard) continue;

    if (!known.has(standard)) {
      out.push({ term, standard, reviewStatus: status, kind: '기준을 찾지 못함',
        note: '우리 DB 에 없는 기준입니다. 기준 JSON 을 먼저 적재해야 합니다.' });
      continue;
    }
    const prev = cur.get(`${keyFn(term)}||${standard}`);
    out.push({
      term, standard, reviewStatus: status,
      kind: prev === undefined ? '새로 추가' : prev === status ? '변화 없음' : '검수상태 바뀜',
      note: prev !== undefined && prev !== status ? `${prev} → ${status}` : undefined,
    });
  }
  return out;
}

/** 미리보기에서 확인한 내용을 실제로 넣는다 */
export async function applyTermsCsv(text: string, reviewer: string | null): Promise<number> {
  const db = getDb();
  const preview = await previewTermsCsv(text);
  const usable = preview.filter((p) => p.kind === '새로 추가' || p.kind === '검수상태 바뀜');

  let n = 0;
  for (const p of usable) {
    const [std] = await db<{ id: number }[]>`
      select id from public.standard where is_current and display_name = ${p.standard}
    `;
    if (!std) continue;
    const status = ['approved', 'rejected', 'auto_unreviewed'].includes(p.reviewStatus)
      ? p.reviewStatus : 'approved';
    await db`
      insert into public.scope_term
        (term, term_key, standard_id, source, evidence, confidence, review_status, reviewed_by, reviewed_at)
      values (${p.term}, public.scope_term_key(${p.term}), ${std.id}, 'EXPERT',
              ${`CSV 가져오기${reviewer ? ` (${reviewer})` : ''}`}, 1, ${status}, ${reviewer}, now())
      on conflict (term_key, standard_id) do update
        set review_status = excluded.review_status, source = 'EXPERT',
            evidence = excluded.evidence, reviewed_by = excluded.reviewed_by, reviewed_at = now()
    `;
    n++;
  }
  return n;
}
