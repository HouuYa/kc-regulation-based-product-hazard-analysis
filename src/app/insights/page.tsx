import { redirect } from 'next/navigation';

/**
 * 옛 주소 — KC안전기준 개선 요인의 세 표는 정책 현황판(/policy) 맨 아래로 옮겼다.
 *
 * 세 표는 담당자 검토가 쌓여야 채워지는 표라, 지금 답할 수 있는 숫자(덮은 범위·위해
 * 분포·불량·불법) 아래에 두는 편이 읽는 순서에 맞다(05 문서 §5.3).
 */
export default function InsightsRedirect() {
  redirect('/policy#review-tables');
}
