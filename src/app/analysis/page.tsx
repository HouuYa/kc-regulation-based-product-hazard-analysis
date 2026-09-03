import { redirect } from 'next/navigation';

/**
 * 옛 주소 — 분석 목록은 사고보고서·리콜 화면으로 나뉘어 들어갔다.
 *
 * 사건 종류에 따라 봐야 할 숫자가 달라 목록을 하나로 두는 것이 오히려 불편했다.
 * 기본은 사고보고서 쪽으로 보낸다.
 */
export default function AnalysisRedirect() {
  redirect('/accidents');
}
