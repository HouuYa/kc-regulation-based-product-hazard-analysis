import { redirect } from 'next/navigation';

/**
 * 옛 주소 — /cases 는 /accidents 로 옮겼다.
 *
 * 사고보고서 등록과 그 분석 현황을 한 화면에 합치면서 이름도 내용에 맞게 바꿨다.
 * 담당자 북마크나 예전 화면의 링크가 죽지 않도록 넘겨준다.
 */
export default function CasesRedirect() {
  redirect('/accidents');
}
