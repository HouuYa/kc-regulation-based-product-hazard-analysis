import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * 옛 주소 — 진척 현황은 관리 콘솔로 옮겼다 (05_02 P3-3, 2026-10-07)
 *
 * 이 화면에는 결정할 버튼이 하나도 없었고, 머리말 흐름도의 숫자를 지표 줄로 한 번 더
 * 보여 줄 뿐이었다. 진척은 관리자가, 위해 분포는 정책 대시보드에서 정책담당자가 본다.
 */
export default function StatusRedirect() {
  redirect('/admin?tab=progress');
}
