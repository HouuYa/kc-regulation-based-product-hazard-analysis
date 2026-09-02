/**
 * 사고보고서 추출 텍스트에서 품목명을 뽑는다.
 *
 * 서식이 통일돼 있어 "품목명 가습기" 처럼 라벨 뒤에 온다(실물 5건 모두 동일).
 * 서식이 다른 보고서가 들어오면 여기서 못 찾고 품목 미확정으로 남는데,
 * 그것이 조용히 틀린 품목을 고르는 것보다 낫다.
 *
 * scripts/tag-cases.ts(L2 코드화)와 scripts/load-cases.ts(사진 분석 컨텍스트)가
 * 같이 쓴다 — 두 곳에 각자 두면 서식이 바뀔 때 한쪽만 고치게 된다.
 */
export function extractItemName(text: string | null): string | null {
  if (!text) return null;
  const m = /품\s*목\s*명\s*[:：]?\s*([^\n\r]{1,30})/.exec(text);
  if (!m) return null;
  return m[1]
    .replace(/담당기관.*$/, '')
    .replace(/[_/]/g, ' ')
    .trim() || null;
}
