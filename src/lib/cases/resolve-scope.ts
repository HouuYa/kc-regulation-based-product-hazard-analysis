/**
 * 품목 확정 (v0.7 §3.2 "품목과 적용기준을 먼저 결정한다")
 *
 * 사건의 품목명을 받아 적용할 기준 세트를 정한다. 순서가 이렇게 되어야 하는 이유는
 * v0.7 이 한 문장으로 정리했다 — "위해요인 코드가 같아도 제품이 다르면 관련 시험이
 * 다르다." 코드로 먼저 검색하면 유아용 의자 사고에 전기다리미 조항이 섞인다.
 *
 * 두 경로로 찾는다.
 *   1) 등록된 품목 이름·별칭과 맞춰 본다 (어린이제품 33종)
 *   2) 못 찾으면 각 기준의 적용범위 원문을 한국어 전문검색으로 뒤진다
 *      KC 60335 계열은 파일명에 품목이 없어 1)로는 절대 찾을 수 없다.
 *      대신 적용범위가 "직물용 전기 스티머", "전기 튀김기, 전기 프라이팬" 처럼
 *      정확히 적고 있다.
 *
 * 못 찾으면 null 을 돌려준다. 억지로 고르지 않는다 — v0.7 은 품목이 불명확하면
 * 전 품목 검색을 자동 실행하지 말고 SCOPE_UNRESOLVED 로 보내라고 명시했다.
 */

import { getDb } from '../db';

export interface ResolvedScope {
  productScopeId: number | null;
  scopeName: string;
  /** 이 품목에 적용되는 기준 id */
  standardIds: number[];
  standardCount: number;
  /** 왜 이 품목·기준으로 봤는가. 화면과 감사에 그대로 쓴다 */
  evidence: string;
  method: '품목명 일치' | '별칭 일치' | '적용범위 검색';
}

/** "전지_보조배터리" → ["전지", "보조배터리"] 처럼 후보를 넓힌다 */
function variants(itemName: string): string[] {
  const cleaned = itemName.replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(/[\s,·/]+/).filter((p) => p.length >= 2);
  return [...new Set([cleaned, ...parts])];
}

/**
 * IEC 계열 기준의 제1부를 적용 세트에 더한다.
 *
 * KC 60335-2-98(가습기)의 조항 본문은 대부분 "제1부의 이 항목을 적용한다" 이다.
 * 제2-x부는 독립된 기준이 아니라 제1부의 개정문이기 때문이다. 실제로 세어 보면
 * 제2-x부가 제1부로 명시 위임한 조항이 2~33% 이고, 요구사항 자체의 양이 다르다.
 *
 *   KC 60335-2-98  요구사항  54개
 *   KC 60335-1     요구사항 395개
 *
 * 제1부를 빼고 검색하면 담당자는 요구사항의 대부분을 보지 못한다. 어린이제품에서
 * 부속서에 공통안전기준을 함께 묶는 것과 같은 구조다(standard_applicability 의
 * COMMON). 전기용품은 적용범위 검색으로 찾으므로 그 묶음이 없어 여기서 만든다.
 */
async function withGeneralPart(standardIds: number[]): Promise<number[]> {
  if (standardIds.length === 0) return standardIds;
  const db = getDb();
  const rows = await db<{ id: number; display_name: string }[]>`
    select id, display_name from public.standard where id = any(${standardIds}::bigint[])
  `;

  // "KC 60335-2-98" → 계열 "60335" → 제1부 "60335-1"
  const wanted = new Set<string>();
  for (const r of rows) {
    const m = r.display_name.match(/\b(\d{4,5})-2-\d+/);
    if (m) wanted.add(`${m[1]}-1`);
  }
  if (wanted.size === 0) return standardIds;

  // display_name 앞의 "KC " 를 떼고 번호만 맞춘다
  const parts = await db<{ id: number }[]>`
    select id from public.standard
    where is_current
      and regexp_replace(display_name, '^[^0-9]*', '') = any (${[...wanted]}::text[])
  `;
  // Number() 로 맞춰 둔다. postgres.js 가 bigint 를 문자열로 주므로 숫자와 문자열이
  // 섞이면 같은 기준이 Set 안에 두 번 들어간다.
  return [...new Set([...standardIds.map(Number), ...parts.map((p) => Number(p.id))])];
}

export async function resolveProductScope(itemName: string): Promise<ResolvedScope | null> {
  const db = getDb();
  const cands = variants(itemName);

  // ── 1) 등록된 품목 (이름 또는 별칭) ───────────────────────────────────
  const [exact] = await db<{ id: number; name: string }[]>`
    select id, name from public.product_scope
    where name = any (${cands}::text[])
       or aliases && ${cands}::text[]
    limit 1
  `;

  if (exact) {
    const stds = await db<{ id: number; relation: string; display_name: string }[]>`
      select s.id, a.relation, s.display_name
      from public.standard_applicability a
      join public.standard s on s.id = a.standard_id
      where a.product_scope_id = ${exact.id} and s.is_current
      order by case a.relation when 'ANNEX' then 1 when 'COMMON' then 2 else 3 end
    `;
    const annex = stds.filter((s) => s.relation === 'ANNEX').length;
    const common = stds.filter((s) => s.relation === 'COMMON').length;
    return {
      productScopeId: exact.id,
      scopeName: exact.name,
      standardIds: stds.map((s) => s.id),
      standardCount: stds.length,
      evidence: `등록된 품목 "${exact.name}" — 부속서 ${annex}건 + 공통안전기준 ${common}건`,
      method: exact.name === itemName.trim() ? '품목명 일치' : '별칭 일치',
    };
  }

  // ── 2) 적용범위 원문 검색 ────────────────────────────────────────────
  //
  // PGroonga 로 찾는다. 조사가 붙어도 잡아야 하기 때문이다("가습기의", "가습기를").
  // 여러 기준이 걸리면 전부 적용 후보로 둔다 — 하나로 좁히는 것은 담당자의 몫이고,
  // 시스템이 임의로 고르면 시험 항목을 놓친다.
  const hits = await db<{ id: number; display_name: string; snippet: string }[]>`
    select s.id, s.display_name,
           substring(s.scope_text from 1 for 120) as snippet
    from public.standard s
    where s.is_current
      and s.scope_text is not null
      and s.scope_text operator(extensions.&@~) ${cands.join(' OR ')}
    limit 10
  `;

  if (hits.length === 0) return null;

  const withParts = await withGeneralPart(hits.map((h) => h.id));

  return {
    // 아직 품목으로 등록하지 않는다. 담당자가 확인한 뒤 등록하는 것이 순서다.
    productScopeId: null,
    scopeName: itemName,
    standardIds: withParts,
    standardCount: withParts.length,
    evidence:
      `적용범위 원문 검색으로 ${hits.length}건` +
      (withParts.length > hits.length ? ` + 제1부 ${withParts.length - hits.length}건` : '') + ' — ' +
      hits.slice(0, 3).map((h) => h.display_name).join(', ') +
      (hits.length > 3 ? ` 외 ${hits.length - 3}건` : ''),
    method: '적용범위 검색',
  };
}

/**
 * 분석에 쓸 기준 id 를 돌려준다.
 *
 * 확정된 품목이 있으면 그 적용기준 세트를, 없으면 사건에 남은 검색 결과를 쓴다.
 * 둘 다 없으면 빈 배열 — 호출자가 SCOPE_UNRESOLVED 로 처리한다.
 */
export async function standardsForCase(caseId: number): Promise<number[]> {
  const db = getDb();

  const [ev] = await db<{ product_scope_id: number | null; item_name: string | null }[]>`
    select product_scope_id, item_name from public.case_event where id = ${caseId}
  `;
  if (!ev) return [];

  if (ev.product_scope_id) {
    const rows = await db<{ id: number }[]>`
      select s.id from public.standard_applicability a
      join public.standard s on s.id = a.standard_id
      where a.product_scope_id = ${ev.product_scope_id} and s.is_current
    `;
    return withGeneralPart(rows.map((r) => Number(r.id)));
  }

  // 품목이 등록되지 않은 전기용품 등 — 적용범위 검색으로 그때그때 찾는다
  if (ev.item_name) {
    const resolved = await resolveProductScope(ev.item_name);
    if (resolved) return resolved.standardIds;
  }
  return [];
}
