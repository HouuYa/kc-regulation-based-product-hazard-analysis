/**
 * CSV 내보내기 공통 (CLAUDE.md §9)
 *
 * 담당자는 실제로 엑셀로 일한다 — 이 프로젝트의 정답지도 엑셀로 받았다.
 * 내보내는 자리가 여럿(용어 사전·분석 결과·원인 다리)이라 규칙을 한 곳에 둔다.
 * 각자 복사해 두면 한쪽만 고치게 된다.
 */

/** 쉼표·따옴표·줄바꿈이 든 값을 CSV 규칙대로 감싼다 */
export function cell(v: string | number | null | undefined): string {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 표 하나를 CSV 문서로 만든다.
 *
 * 맨 앞에 BOM 을 붙인다 — 엑셀은 BOM 이 없는 UTF-8 CSV 를 한글이 깨진 채로 연다.
 * 담당자가 파일을 열자마자 깨진 글자를 보면 그다음은 없다.
 */
export function toCsv(header: readonly string[], rows: Array<Array<string | number | null | undefined>>): string {
  const lines = [header.map(cell).join(',')];
  for (const r of rows) lines.push(r.map(cell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** 파일로 저장되도록 헤더를 붙여 응답한다. 서버 액션은 헤더를 정할 수 없어 라우트로 둔다 */
export function csvResponse(csv: string, basename: string): Response {
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${basename}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
