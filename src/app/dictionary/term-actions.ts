'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';

/**
 * 품목 용어 사전 조작
 *
 * 왜 이 화면이 필요한가
 *   이 사전이 기준 선택을 좌우한다. 사고보고서 70건에서 품목 확정이
 *   7건(10%) → 58건(83%)이 된 것이 이 사전 덕이다. 그만큼 틀리면 크게 틀린다 —
 *   잘못된 기준이 붙으면 다른 제품의 시험이 담당자에게 근거로 제시된다.
 *
 *   그런데 AI 가 찾아낸 대응이 계속 미검수로 쌓인다. 확정·반려할 자리가 없으면
 *   사전이 검토되지 않은 채 자란다. 그것을 막는 화면이다.
 *
 * 사전이 조용히 바뀌면 안 된다
 *   사전이 바뀌면 검색 결과가 바뀐다. 그래서 모든 변경은 누가 언제 했는지 남기고,
 *   가져오기는 무엇이 바뀌는지 먼저 보여 준 뒤에만 적용한다.
 */

/** 용어 하나의 모든 기준 대응을 한꺼번에 판정한다 — 검수자는 용어 단위로 본다 */
export async function reviewTerm(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const termKey = String(formData.get('termKey') ?? '').trim();
  const to = String(formData.get('toStatus') ?? '');
  const reviewer = String(formData.get('reviewer') ?? '').trim() || null;

  if (!termKey) return '용어를 찾지 못했습니다.';
  if (to !== 'approved' && to !== 'rejected') return '알 수 없는 검수 결과입니다.';

  try {
    const db = getDb();
    const [r] = await db<{ n: number }[]>`
      with upd as (
        update public.scope_term
        set review_status = ${to}, reviewed_by = ${reviewer}, reviewed_at = now()
        where term_key = ${termKey} and review_status is distinct from ${to}
        returning 1
      )
      select count(*)::int as n from upd
    `;
    // GPC 대응도 같이 판정한다 — 같은 용어에 대한 판단이므로 따로 물을 이유가 없다
    await db`
      update public.scope_term_gpc
      set review_status = ${to}, reviewed_by = ${reviewer}, reviewed_at = now(), updated_at = now()
      where term_key = ${termKey} and review_status is distinct from ${to}
    `;
    revalidatePath('/terms');
    if (r.n === 0) return '이미 같은 상태였습니다.';
    return to === 'approved'
      ? `확정했습니다 — 기준 ${r.n}건. 이제 이 품목은 사전으로 바로 찾습니다.`
      : `반려했습니다 — 기준 ${r.n}건. 이 대응은 더 이상 쓰지 않습니다.`;
  } catch (e) {
    console.error(`용어 검수 실패 (${termKey}):`, e);
    return `처리하지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/** 사전에 없는 용어를 담당자가 직접 넣는다 */
export async function addTerm(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const term = String(formData.get('term') ?? '').trim();
  const standardName = String(formData.get('standard') ?? '').trim();
  const reviewer = String(formData.get('reviewer') ?? '').trim() || null;

  if (!term) return '품목명을 적어 주세요.';
  if (!standardName) return '기준을 골라 주세요.';

  try {
    const db = getDb();
    const [std] = await db<{ id: number; display_name: string }[]>`
      select id, display_name from public.standard
      where is_current and display_name = ${standardName}
    `;
    if (!std) return `"${standardName}" 기준을 찾지 못했습니다.`;

    await db`
      insert into public.scope_term
        (term, term_key, standard_id, source, evidence, confidence, review_status, reviewed_by, reviewed_at)
      values (${term}, public.scope_term_key(${term}), ${std.id}, 'EXPERT',
              ${`담당자가 화면에서 직접 추가${reviewer ? ` (${reviewer})` : ''}`},
              1, 'approved', ${reviewer}, now())
      on conflict (term_key, standard_id) do update
        set source = 'EXPERT', review_status = 'approved',
            evidence = excluded.evidence, reviewed_by = excluded.reviewed_by,
            reviewed_at = now()
    `;
    revalidatePath('/terms');
    return `추가했습니다 — "${term}" → ${std.display_name}`;
  } catch (e) {
    console.error('용어 추가 실패:', e);
    return `추가하지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/**
 * 용어를 사전에서 지운다.
 *
 * 반려와 다르다 — 반려는 "아니다"를 기록으로 남기고, 삭제는 흔적을 없앤다.
 * 잘못 넣은 것은 지우고, 검토해서 아니라고 판단한 것은 반려하는 것이 맞다.
 */
export async function deleteTerm(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const termKey = String(formData.get('termKey') ?? '').trim();
  if (!termKey) return '용어를 찾지 못했습니다.';
  try {
    const db = getDb();
    const [r] = await db<{ n: number }[]>`
      with d as (delete from public.scope_term where term_key = ${termKey} returning 1)
      select count(*)::int as n from d
    `;
    await db`delete from public.scope_term_gpc where term_key = ${termKey}`;
    revalidatePath('/terms');
    return r.n === 0 ? '지울 것이 없었습니다.' : `지웠습니다 — 기준 대응 ${r.n}건.`;
  } catch (e) {
    console.error(`용어 삭제 실패 (${termKey}):`, e);
    return `지우지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}
