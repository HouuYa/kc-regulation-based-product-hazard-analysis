'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { CLAUSE_REJECT_REASONS } from './reject-options';

/**
 * 조항 태그 검수 — 담당자의 판단을 기록으로 남기는 자리
 *
 * 이 화면이 없던 동안 무슨 일이 있었나
 *   clause_tag.review_status 를 바꾸는 코드가 저장소에 한 줄도 없었다. 그래서
 *   조항 태그 1,855건이 100% auto_unreviewed 였고, 근거등급 A 는 나올 수 없었으며,
 *   030 이 만든 "검수 확정분만 검색에 쓰기" 스위치는 켤 수가 없었다.
 *   장치는 다 있는데 사람이 판단을 넣을 입구가 없었다.
 *
 * 왜 조항 단위로 받는가
 *   검수자는 조항 본문을 읽고 판단한다. 코드 하나씩 누르게 하면 같은 본문을
 *   여러 번 읽어야 하고, 그러면 뒤로 갈수록 대충 누르게 된다. 판단의 질이
 *   떨어지는 쪽으로 화면이 유도하면 안 된다.
 *
 * 상태 변경과 이력을 한 트랜잭션으로 묶는 일은 DB 함수가 한다(037).
 * 여기서는 입력을 검사하고 결과를 문장으로 돌려줄 뿐이다.
 */
export async function reviewClause(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const clauseId = Number(formData.get('clauseId'));
  const toStatus = String(formData.get('toStatus') ?? '');
  const rejectReason = String(formData.get('rejectReason') ?? '').trim() || null;
  const reviewer = String(formData.get('reviewer') ?? '').trim() || null;

  if (!Number.isInteger(clauseId) || clauseId <= 0) return '조항을 찾지 못했습니다.';

  // 주소줄이 아니라 폼에서 오는 값이지만, 서버에서 다시 확인한다 —
  // 허용 목록 밖의 값이 DB 제약에 걸려 500 으로 죽는 것보다 낫다
  if (toStatus !== 'approved' && toStatus !== 'rejected') {
    return '알 수 없는 검수 결과입니다.';
  }
  if (toStatus === 'rejected') {
    if (!rejectReason) return '반려하려면 사유를 골라 주세요.';
    if (!CLAUSE_REJECT_REASONS.some((r) => r.value === rejectReason)) {
      return '알 수 없는 반려 사유입니다.';
    }
  }

  try {
    const [row] = await getDb()<{ n: number }[]>`
      select public.review_clause_tags(
        ${clauseId}, ${toStatus}, ${reviewer},
        ${toStatus === 'rejected' ? rejectReason : null}, null
      ) as n
    `;
    revalidatePath('/standards/review');

    if (row.n === 0) return '이미 같은 상태였습니다. 바뀐 것이 없습니다.';
    return toStatus === 'approved'
      ? `확정했습니다 — 코드 ${row.n}건. 이제 이 조항은 근거등급 A 로 제시됩니다.`
      : `반려했습니다 — 코드 ${row.n}건. 이 코드는 검색에서 빠집니다.`;
  } catch (e) {
    console.error(`조항 검수 실패 (조항 ${clauseId}):`, e);
    return `처리하지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}
