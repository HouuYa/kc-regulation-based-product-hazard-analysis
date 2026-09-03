'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { runAnalysis } from '@/lib/search/run';
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

/**
 * 분석 실행 — 화면 버튼 (담당자 요청)
 *
 * 왜 생겼나
 *   지금까지 분석을 돌리는 길은 `npm run search -- --case 4639` 하나뿐이었다.
 *   그래서 화면 곳곳에 그 명령어가 안내로 박혀 있었고, 터미널을 쓰지 않는
 *   담당자는 분석을 시작할 방법이 없었다. 그 명령어 안내를 화면에서 지우고
 *   이 버튼으로 대신한다.
 *
 * 서버리스에서 돌려도 되는가
 *   된다. 사건 1건 분석은 SQL 검색 한 번 + 재채점 LLM 호출 한 번이라 몇 초로 끝난다.
 *   오래 걸리는 것은 전량 코드 부여(요건 조항 5,902건)이고 그건 이 버튼이 하는 일이 아니다.
 *
 * 결과를 반드시 말해 준다
 *   실측에서 드러난 문제다. 품목에 맞는 기준을 못 찾으면(SCOPE_UNRESOLVED) 설계상
 *   분석을 만들지 않는데, 그러면 화면이 눌리기 전과 똑같아 보인다. 담당자는 버튼이
 *   고장 난 줄 안다. 그래서 어떤 경우든 무슨 일이 있었는지 문장으로 돌려보낸다.
 *
 * 로직은 src/lib/search/run.ts 에 있다
 *   명령줄과 화면이 같은 함수를 쓴다. 복사해 두면 한쪽만 고치게 된다(CLAUDE.md §9).
 */
export async function runAnalysisAction(formData: FormData): Promise<void> {
  const caseId = Number(formData.get('caseId'));
  const returnTo = String(formData.get('returnTo') ?? `/analysis/${caseId}`);
  if (!caseId) return;

  let message: string;
  try {
    const out = await runAnalysis(caseId);

    if (out.scopeUnresolved) {
      // 실측으로 드러난 자리 — 버튼을 눌렀는데 화면이 아무 말도 안 하던 경우다.
      // 설계상 이때는 분석을 만들지 않는 것이 맞지만(v0.7 §3.2), 그 사실을 말해
      // 주지 않으면 담당자는 버튼이 고장 난 줄 안다.
      message =
        '이 제품에 어떤 안전기준을 적용할지 정하지 못해 분석하지 않았습니다. ' +
        '품목을 먼저 확정해야 합니다 — 전 기준을 뒤지면 다른 제품의 시험이 섞입니다.';
    } else if (out.candidates.length === 0) {
      message =
        `관련될 수 있는 조항을 찾지 못했습니다(사유: ${out.emptyReason}). ` +
        '이것이 곧 "기준에 조항이 없다"는 뜻은 아닙니다.';
    } else {
      message = `분석했습니다 — 관련될 수 있는 조항 ${out.candidates.length}건을 찾았습니다.`;
    }
  } catch (e) {
    console.error(`분석 실행 실패 (사건 ${caseId}):`, e);
    message = `분석에 실패했습니다 — ${e instanceof Error ? e.message : e}`;
  }

  revalidatePath(`/analysis/${caseId}`);
  revalidatePath(returnTo);
  // redirect() 는 try 밖에서 부른다 — 안에서 부르면 catch 가 그 신호를 삼킨다
  redirect(`${returnTo}?done=${encodeURIComponent(message)}`);
}
