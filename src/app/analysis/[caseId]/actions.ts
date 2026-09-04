'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { runAnalysis } from '@/lib/search/run';
import { NOT_READY_LABEL, NOT_READY_ACTION } from '@/lib/search/readiness';
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
 * 결과를 누른 자리에서 말해 준다
 *   처음에는 결과를 주소줄에 실어 화면 맨 위에 띠로 그렸다. 그런데 목록을 한참
 *   내려간 상태에서 누르면 그 띠가 보이지 않았고, 특히 "적용할 기준을 못 찾아
 *   분석하지 않았습니다"처럼 아무 변화가 없는 경우에는 버튼이 죽은 것처럼 보였다
 *   (담당자 지적: "분석 실행이 안먹히네요").
 *
 *   그래서 주소를 바꾸지 않고 문장만 돌려준다. 버튼 옆에 바로 붙고, 화면은
 *   깜빡이지 않으며, 스크롤 위치도 그대로다(components/ActionForm.tsx).
 *
 * 로직은 src/lib/search/run.ts 에 있다
 *   명령줄과 화면이 같은 함수를 쓴다. 복사해 두면 한쪽만 고치게 된다(CLAUDE.md §9).
 */
export async function runAnalysisAction(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const caseId = Number(formData.get('caseId'));
  if (!caseId) return '사건을 찾지 못했습니다.';

  let message: string;
  try {
    const out = await runAnalysis(caseId);

    if (out.notReady.length > 0) {
      // 자료가 안 갖춰져 실행하지 않았다. 무엇이 빠졌고 다음에 무엇을 하면 되는지
      // 둘 다 말해 준다 — 사유만 말하면 담당자는 그다음을 또 물어야 한다
      message =
        '아직 분석할 수 있는 상태가 아닙니다. ' +
        out.notReady.map((r) => `${NOT_READY_LABEL[r]} — ${NOT_READY_ACTION[r]}`).join(' / ');
    } else if (out.scopeUnresolved) {
      // 실측으로 드러난 자리 — 버튼을 눌렀는데 화면이 아무 말도 안 하던 경우다.
      // 설계상 이때는 분석을 만들지 않는 것이 맞지만(v0.7 §3.2), 그 사실을 말해
      // 주지 않으면 담당자는 버튼이 고장 난 줄 안다.
      message =
        '이 제품에 어떤 안전기준을 적용할지 정하지 못해 분석하지 않았습니다. ' +
        '품목을 먼저 확정해야 합니다 — 모든 기준을 뒤지면 다른 제품의 시험이 섞입니다.';
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

  // 화면은 ActionForm 이 router.refresh() 로 새로 읽는다. 주소는 바꾸지 않는다.
  revalidatePath(`/analysis/${caseId}`);
  revalidatePath('/accidents');
  revalidatePath('/recalls');
  return message;
}
