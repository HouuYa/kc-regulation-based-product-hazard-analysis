import { redirect } from 'next/navigation';

/**
 * 옛 주소 — 인사이트 화면은 검토 화면과 하나로 합쳤다 (05_02 P2-1, 2026-10-07)
 *
 * 둘로 나누자 판정 버튼(검토)과 판정 근거(보고서가 한 시험·병행 점검 근거, 인사이트)가
 * 다른 화면에 놓여 담당자가 오가야 했다. 내용은 `../Reference.tsx` 와 검토 화면으로 옮겼다.
 */
export default async function InsightRedirect({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  redirect(`/analysis/${encodeURIComponent(caseId)}#analysis-reference`);
}
