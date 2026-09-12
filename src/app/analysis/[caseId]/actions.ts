'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { runAnalysis } from '@/lib/search/run';
import { runSecondOpinion } from '@/lib/second-opinion/run';
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
 * 병행 점검 실행 — 화면 버튼 (070)
 *
 * 기본 분석(runAnalysisAction)과 따로 두는 이유
 *   이 둘은 성격이 다르다. 기본 분석은 "이 피해유형을 다루는 조항"을 찾고,
 *   병행 점검은 "보고서가 시험하지 않은 구간"을 찾는다. 한 버튼으로 묶으면
 *   담당자가 두 목록의 성격 차이를 알 수 없게 되고, 무엇보다 병행 점검이
 *   기본 목록을 덮어쓰는 것처럼 읽힌다 — 04-1 §8 이 금지한 것이다.
 *
 * 로직은 src/lib/second-opinion/run.ts 에 있다. 명령줄과 같은 함수다.
 */
export async function runSecondOpinionAction(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const caseId = Number(formData.get('caseId'));
  if (!caseId) return '사건을 찾지 못했습니다.';

  let message: string;
  try {
    const o = await runSecondOpinion(caseId);
    if (o.skipped) {
      message = `병행 점검을 하지 않았습니다 — ${o.skipped}`;
    } else if (o.standardIds.length === 0) {
      // 분모가 없으면 "시험하지 않은 구간"이 성립하지 않는다. 리콜 근거는 나왔을 수 있다
      message =
        '적용할 안전기준을 정하지 못해 시험 범위 공백은 내지 못했습니다. ' +
        '품목을 먼저 확정해야 합니다. ' +
        (o.recall?.similar.length ? `닮은 리콜 ${o.recall.similar.length}건은 찾았습니다.` : '');
    } else {
      const unmapped = o.matches.filter((m) => !m.mapped).length;
      message =
        `병행 점검했습니다 — 보고서가 시험한 것은 ${o.matches.length}건이고, ` +
        `이 품목의 요건은 ${o.gap?.requirementSectionCount ?? 0}개 절입니다. ` +
        `그중 이 사고와 닿는데 시험하지 않은 것 ${o.gap?.sections.length ?? 0}개를 찾았습니다.` +
        (unmapped > 0 ? ` (시험명 ${unmapped}건은 조항에 맞추지 못했습니다)` : '');
    }
  } catch (e) {
    console.error(`병행 점검 실패 (사건 ${caseId}):`, e);
    message = `병행 점검에 실패했습니다 — ${e instanceof Error ? e.message : e}`;
  }

  revalidatePath(`/analysis/${caseId}`);
  return message;
}

/**
 * 소견에 대한 담당자 판정 (070)
 *
 * review_log 와 같은 모양으로 쌓는다. 시험 범위 공백은 정답지가 없으므로
 * ─ 정답셋 47건은 "보고서가 실제로 수행한 시험"이라 공백은 정의상 그 밖이다 ─
 * 이 표에 쌓이는 채택률이 이 계층의 유일한 성적표다.
 */
export async function recordFindingReview(formData: FormData): Promise<void> {
  const findingId = Number(formData.get('findingId'));
  const decision = String(formData.get('decision'));
  const caseId = String(formData.get('caseId'));
  if (!findingId || !['ACCEPTED', 'HOLD', 'REJECTED'].includes(decision)) return;

  await getDb()`
    insert into public.second_opinion_review (finding_id, decision, note, reviewer)
    values (${findingId}, ${decision},
            ${(formData.get('note') as string | null) || null}, ${'담당자'})
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

/**
 * 어린이제품 여부를 담당자가 확정한다 (055)
 *
 * 왜 사람이 하는가
 *   「어린이제품 가이드라인」 고시는 색상·포장·광고·소비자 인식·가격대까지 결정요소로
 *   든다. 제품 실물과 판매 맥락을 봐야 하는 판단이라 기계가 흉내 내면 그럴듯한 오답이
 *   나온다(docs/wiki/개념/법령제도/어린이제품_가이드라인.md).
 *
 * 무엇이 달라지는가
 *   CHILD 로 정하면 적용 기준에 어린이제품 공통안전기준이 들어가고, NOT_CHILD 면
 *   자동 판정이 붙였더라도 빠진다(resolve-scope.ts 의 childOverride).
 *
 * 근거를 함께 받는다
 *   무엇을 보고 그렇게 정했는지가 남지 않으면 다음 사람이 다시 판정해야 한다.
 *   비워 두어도 저장은 되지만, 화면이 근거 칸을 늘 보여 준다.
 */
export async function setChildProductCheck(formData: FormData): Promise<void> {
  const caseId = Number(formData.get('caseId'));
  const value = String(formData.get('value') ?? '');
  const note = (formData.get('note') as string | null)?.trim() || null;

  const allowed = ['UNCHECKED', 'CHILD', 'NOT_CHILD', 'UNKNOWN'];
  if (!caseId || !allowed.includes(value)) return;

  await getDb()`
    update public.case_event
    set child_product_check = ${value},
        child_product_note = ${note},
        child_product_checked_at = ${value === 'UNCHECKED' ? null : new Date()}
    where id = ${caseId}
  `;

  revalidatePath(`/analysis/${caseId}`);
}
