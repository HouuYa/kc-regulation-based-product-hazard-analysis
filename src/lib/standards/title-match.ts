/**
 * 조항 제목을 견주는 규칙
 *
 * 원래 scripts/link-test-methods.ts 안에만 있던 함수다. 병행 점검(070)이
 * "보고서가 수행했다고 적은 시험명" 을 조항 제목에 맞춰 보는 데 같은 규칙을
 * 쓰게 되어 공유 자리로 옮겼다. 두 곳에 복사해 두면 규칙이 갈라질 때 한쪽만
 * 고치게 된다.
 *
 * 왜 좁게 잡는가
 *   틀린 연결은 없는 연결보다 나쁘다. 담당자에게 엉뚱한 시험을 의뢰하게 만든다.
 */

/** 두루뭉술해서 짝을 지을 수 없는 제목 */
export const STOP_TITLES = new Set([
  '시험방법', '검사방법', '시험', '검사', '일반', '일반사항', '일반조건',
  '정의', '용어의 정의', '적용범위', '기타', '표시', '시험의 일반조건',
]);

/** 괄호를 털고 한글·영숫자만 남겨 공백 하나로 고른다 */
export function normTitle(t: string | null): string {
  if (!t) return '';
  return t
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^가-힣A-Za-z0-9]+/g, ' ')
    .trim();
}

/**
 * 짧은 쪽이 긴 쪽의 앞머리이고 낱말 경계에서 끊기면 그 공통 제목을 돌려준다.
 *
 * 「작은 부품」 ↔ 「작은 부품 시험」 은 잇고, 「작은」 ↔ 「작은방」 은 안 잇는다.
 */
export function prefixMatch(a: string, b: string): string | null {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 4) return null;
  if (!l.startsWith(s)) return null;
  if (l.length > s.length && l[s.length] !== ' ') return null;
  return s;
}

/**
 * 띄어쓰기를 무시하고 견준다 — 보고서의 시험명을 기준의 조항 제목에 맞출 때 쓴다.
 *
 * 왜 prefixMatch 를 그대로 못 쓰는가 (070 구현 중 실측으로 잡았다)
 *   사고보고서는 「온도상승」이라 쓰고 KC 60335-1 은 「온도 상승」이라 쓴다.
 *   prefixMatch 는 낱말 경계를 보느라 이 둘을 남으로 판정했고, 그 결과
 *   **보고서가 실제로 수행한 온도상승 시험이 "시험하지 않은 절" 1위로 나왔다.**
 *   공백 목록에서 가장 위험한 종류의 거짓이다 — 조사관이 한 일을 안 했다고 말한다.
 *
 * 그런데 왜 prefixMatch 쪽은 안 고치나
 *   그 함수는 같은 기준 안에서 요건 조항과 시험 조항을 잇는 데 쓰인다. 거기서는
 *   낱말 경계가 「작은 부품」과 「작은방」을 가르는 장치라 없애면 틀린 연결이 는다.
 *   쓰임이 다르므로 함수를 나눈다.
 *
 * 띄어쓰기를 없애면 경계 검사도 사라지므로 최소 길이를 둔다. 처음에 4로 잡았더니
 * 「내습성」이 걸러졌다 — 한국어 기술용어는 세 글자로도 충분히 특정하다
 * (내습성·절연성·내구성). 대신 「구조」·「일반」·「표시」 같은 두 글자 두루뭉술한
 * 말은 그대로 막힌다. STOP_TITLES 가 한 겹 더 거른다.
 */
export function spacelessMatch(a: string, b: string): string | null {
  const sa = a.replace(/\s+/g, '');
  const sb = b.replace(/\s+/g, '');
  const [s, l] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (s.length < 3) return null;
  return l.startsWith(s) ? s : null;
}
