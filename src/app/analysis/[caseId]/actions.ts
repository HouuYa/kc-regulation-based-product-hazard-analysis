'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import type { Decision } from './review-options';

/**
 * 담당자 판단 기록 (설계문서 §7.2)
 *
 * 이 표가 이 체계에서 가장 값나가는 자산이다. 지금까지 담당자 개인의 경험에 머물던
 * 판단이 처음으로 구조화된 데이터로 쌓이는 자리이고, §5.8 의 재현율·오탐률도
 * 여기서 계산된다.
 *
 * 덮어쓰지 않고 쌓는다 (§7.1 판단층)
 *   판단을 바꾸면 새 행이 들어간다. 언제 무엇을 왜 바꿨는지가 남아야
 *   나중에 "그때는 왜 그렇게 판단했는가"를 되짚을 수 있다.
 */
export async function recordReview(formData: FormData): Promise<void> {
  const matchResultId = Number(formData.get('matchResultId'));
  const decision = String(formData.get('decision')) as Decision;
  const rejectReason = (formData.get('rejectReason') as string | null) || null;
  const note = (formData.get('note') as string | null) || null;
  const caseId = String(formData.get('caseId'));

  if (!matchResultId || !decision) return;

  await getDb()`
    insert into public.review_log (match_result_id, decision, reject_reason, note, reviewer)
    values (${matchResultId}, ${decision},
            ${decision === 'REJECTED' ? rejectReason : null},
            ${note}, ${'담당자'})
  `;

  revalidatePath(`/analysis/${caseId}`);
}
