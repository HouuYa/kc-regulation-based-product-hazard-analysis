'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { previewKeywordsCsv, applyKeywordsCsv, type KeywordPreviewRow } from '@/lib/terms/keyword-csv';
import { suggestAliases, saveAliases, type AliasTarget } from '@/lib/terms/alias';

/**
 * 별칭 사전 조작
 *
 * 이 사전이 하는 일
 *   일상어를 법정 품목으로 옮긴다. "천장등"이 「조명기기 > 일반조명기구 > LED등기구」
 *   임을 알아야 그다음에 적용 기준을 찾을 수 있다.
 *
 * 왜 검수가 필요한가
 *   AI 가 제안한 별칭이 틀리면 엉뚱한 품목으로 인식되고, 그러면 엉뚱한 기준의 시험이
 *   담당자에게 근거로 제시된다. 조용히 틀리는 종류의 고장이라 사람이 한 번은 봐야 한다.
 */

/** 별칭 하나를 확정하거나 반려한다 */
export async function reviewKeyword(_prev: string | null, formData: FormData): Promise<string> {
  const id = Number(formData.get('id'));
  const to = String(formData.get('toStatus') ?? '');
  if (!id) return '항목을 찾지 못했습니다.';
  if (to !== 'approved' && to !== 'rejected') return '알 수 없는 검수 결과입니다.';

  try {
    const [r] = await getDb()<{ keyword: string }[]>`
      update public.item_keyword set review_status = ${to}
      where id = ${id} and review_status is distinct from ${to}
      returning keyword
    `;
    revalidatePath('/keywords');
    if (!r) return '이미 같은 상태였습니다.';
    return to === 'approved'
      ? `"${r.keyword}" 을 확정했습니다.`
      : `"${r.keyword}" 을 반려했습니다. 더 이상 쓰지 않습니다.`;
  } catch (e) {
    console.error(`별칭 검수 실패 (${id}):`, e);
    return `처리하지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/** 한 품목의 AI 제안을 통째로 판정한다 — 검수자는 품목 단위로 본다 */
export async function reviewTarget(_prev: string | null, formData: FormData): Promise<string> {
  const group = String(formData.get('itemGroup') ?? '');
  const target = String(formData.get('target') ?? '');
  const to = String(formData.get('toStatus') ?? '');
  if (!group || !target) return '품목을 찾지 못했습니다.';
  if (to !== 'approved' && to !== 'rejected') return '알 수 없는 검수 결과입니다.';

  try {
    const [r] = await getDb()<{ n: number }[]>`
      with upd as (
        update public.item_keyword set review_status = ${to}
        where item_group = ${group} and coalesce(sub_item, item, '') = ${target}
          and source = 'LLM' and review_status is distinct from ${to}
        returning 1
      ) select count(*)::int n from upd
    `;
    revalidatePath('/keywords');
    return r.n === 0 ? '바뀐 것이 없습니다.' : `AI 제안 ${r.n}개를 ${to === 'approved' ? '확정' : '반려'}했습니다.`;
  } catch (e) {
    console.error(`품목 단위 검수 실패 (${target}):`, e);
    return `처리하지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/** 담당자가 별칭을 직접 넣는다. 사람이 넣은 것은 바로 확정 상태다 */
export async function addKeyword(_prev: string | null, formData: FormData): Promise<string> {
  const group = String(formData.get('itemGroup') ?? '').trim();
  const item = String(formData.get('item') ?? '').trim() || null;
  const sub = String(formData.get('subItem') ?? '').trim() || null;
  const keyword = String(formData.get('keyword') ?? '').trim();

  if (!group || !keyword) return '품목군과 검색어를 모두 적어 주세요.';
  if (!item && !sub) return '어느 품목의 검색어인지 적어 주세요.';

  try {
    const [r] = await getDb()<{ id: number }[]>`
      insert into public.item_keyword
        (item_group, item, sub_item, keyword, keyword_key, source, review_status)
      values (${group}, ${item}, ${sub}, ${keyword},
              public.scope_term_key(${keyword}), 'EXPERT', 'approved')
      on conflict (keyword_key, item_group, coalesce(sub_item, ''), coalesce(item, ''))
      do nothing
      returning id
    `;
    revalidatePath('/keywords');
    return r ? `"${keyword}" 을 넣었습니다.` : '이미 있는 검색어입니다.';
  } catch (e) {
    console.error('별칭 추가 실패:', e);
    return `넣지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

export async function deleteKeyword(_prev: string | null, formData: FormData): Promise<string> {
  const id = Number(formData.get('id'));
  if (!id) return '항목을 찾지 못했습니다.';
  try {
    const [r] = await getDb()<{ keyword: string }[]>`
      delete from public.item_keyword where id = ${id} returning keyword
    `;
    revalidatePath('/keywords');
    return r ? `"${r.keyword}" 을 지웠습니다.` : '이미 없습니다.';
  } catch (e) {
    console.error(`별칭 삭제 실패 (${id}):`, e);
    return `지우지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/**
 * 한 품목에 AI 로 별칭을 더 만든다 (화면 버튼)
 *
 * 목록을 보다가 "이 품목은 검색어가 너무 적다" 싶을 때 그 자리에서 부른다.
 * 명령줄로 전량을 돌리는 것(npm run alias:build)과 같은 함수를 쓴다.
 */
export async function suggestForTarget(_prev: string | null, formData: FormData): Promise<string> {
  const group = String(formData.get('itemGroup') ?? '');
  const item = String(formData.get('item') ?? '') || null;
  const sub = String(formData.get('subItem') ?? '') || null;
  if (!group || (!item && !sub)) return '품목을 찾지 못했습니다.';

  try {
    const target: AliasTarget = { itemGroup: group, item, subItem: sub, hint: null };
    const out = await suggestAliases([target]);
    if (out.length === 0) return 'AI 가 검색어를 만들지 못했습니다.';
    const saved = await saveAliases(out);
    revalidatePath('/keywords');
    return saved === 0
      ? '새로 더할 검색어가 없었습니다 — 이미 다 들어 있습니다.'
      : `AI 가 검색어 ${saved}개를 제안했습니다. 확인 후 확정해 주세요.`;
  } catch (e) {
    console.error('별칭 제안 실패:', e);
    return `만들지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/* ── 가져오기 (두 단계) ─────────────────────────────────────────────────── */

export async function previewImport(csv: string): Promise<{ rows: KeywordPreviewRow[] }> {
  try {
    return { rows: await previewKeywordsCsv(csv) };
  } catch (e) {
    console.error('별칭 사전 미리보기 실패:', e);
    return { rows: [] };
  }
}

export async function applyImport(csv: string): Promise<string> {
  try {
    const n = await applyKeywordsCsv(csv);
    revalidatePath('/keywords');
    return n === 0 ? '바뀐 것이 없습니다.' : `${n}건을 반영했습니다.`;
  } catch (e) {
    console.error('별칭 사전 가져오기 실패:', e);
    return `반영하지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}
