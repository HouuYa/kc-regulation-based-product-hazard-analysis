import { loadPolicyStats, type CrossCount } from '@/lib/policy/stats';
import { toCsv, csvResponse } from '@/lib/csv';

export const dynamic = 'force-dynamic';

/**
 * GET /api/policy/export — 정책 현황판의 표를 CSV 한 장으로 내려준다
 *
 * 보고용이다. 표마다 파일을 나누면 담당자가 여러 개를 받아 합쳐야 해서, 「표」 열로
 * 구분한 긴 표 한 장으로 낸다. 파일 이름에 기준일(오늘 날짜)이 들어간다(csvResponse).
 * 결론 문장은 넣지 않는다 — 숫자와 분모까지만.
 */
export async function GET() {
  const s = await loadPolicyStats();
  const rows: Array<Array<string | number | null>> = [];
  const push = (table: string, a: string, b: string | null, n: number, d: number | null, note = '') =>
    rows.push([table, a, b, n, d, d ? Math.round((n / d) * 1000) / 10 : null, note]);

  for (const c of s.coverage) {
    const src = c.source_type === 'ACCIDENT' ? '사고보고서' : '해외 리콜';
    push('덮은 범위', src, '원인 코드 있음', c.hf_coded, c.total);
    push('덮은 범위', src, '대표 원인이 원인 미확인뿐', c.hf_unknown, c.total);
    push('덮은 범위', src, '품목 분류됨(자동 판정·원본 DB·담당자)', c.classified, c.total);
    push('덮은 범위', src, '담당자가 품목 지정', c.scoped, c.total);
    push('덮은 범위', src, '원문 확인', c.confirmed, c.total, '사고보고서에서만 뜻이 있음');
    push('덮은 범위', src, '발생일 없음', c.no_date, c.total);
    push('덮은 범위', src, '조항 후보 검색', c.analyzed, c.total);
    push('덮은 범위', src, '병행 점검', c.second_opinion, c.total);
    push('덮은 범위', src, '담당자 채택·반려 기록', c.reviews, null);
  }
  push('덮은 범위', '해외 리콜', '국내 유통 확인', s.domestic.checked, s.domestic.total, '0이면 미확인이지 미유통이 아님');

  const total = s.coverage.find((c) => c.source_type === 'RECALL_OVERSEAS')?.total ?? null;
  for (const c of s.codes) {
    push(c.axis === 'DT' ? '대표 피해유형' : '대표 원인', c.code, c.name_ko, c.cases, total,
      `관리자 분류 ${c.approved} / AI 보충 ${c.cases - c.approved}${c.route ? ` / 확인 경로 ${c.route}` : ''}`);
  }

  // 교차표는 원자료 그대로 — 월별은 분모(그달 합계)를 같이 적어 비중을 다시 셀 수 있게 한다
  const totals = (data: CrossCount[]) => {
    const m = new Map<string, number>();
    for (const r of data) m.set(r.key, (m.get(r.key) ?? 0) + r.cases);
    return m;
  };
  const ct = totals(s.byCountry);
  for (const r of s.byCountry) push('국가 × 대표 피해유형', r.key, r.code, r.cases, ct.get(r.key) ?? null);
  const mt = totals(s.byMonth);
  for (const r of s.byMonth) {
    push('월 × 대표 피해유형', r.key, r.code, r.cases, mt.get(r.key) ?? null, '월별 건수는 수집량 변화를 반영함 — 비중으로 읽을 것');
  }

  for (const k of s.kinds) {
    push('병행 점검 최신 실행 소견', k.output_kind, `사고 ${k.cases}건`, k.rows, null,
      k.output_kind === 'TEST_ITEM' ? '불량(시험항목) 후보'
        : k.output_kind === 'CERT_MARKING_CHECK' ? '불법(인증·표시 확인항목) 후보'
          : k.output_kind === 'POLICY_SIGNAL' ? '사각지대 후보(전문가 확인 필요)' : '참고 자료');
  }
  for (const p of s.signals) {
    push('사각지대 후보', String(p.case_id), p.title, 1, null, `전문가 확인 필요 / 원문: ${p.evidence ?? ''}`);
  }
  push('근거 표준 번호 연결', '근거 표준이 적힌 리콜', null, s.standards.cited, s.standards.total);
  push('근거 표준 번호 연결', '국내 기준과 번호로 이어짐', null, s.standards.matched, s.standards.cited,
    '못 이음 ≠ 국내 기준 없음');

  return csvResponse(toCsv(['표', '항목', '세부', '건수', '분모', '비율(%)', '비고'], rows), 'policy-dashboard');
}
