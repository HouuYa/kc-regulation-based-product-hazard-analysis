import { loadBridge, type CauseRoute } from '@/lib/codebook/cause-bridge';
import { toCsv, csvResponse } from '@/lib/csv';

export const dynamic = 'force-dynamic';

const ROUTE_KO: Record<CauseRoute, string> = {
  TEST: '시험(불량)',
  LEGAL: '법령(불법)',
  GAP: '기준공백',
  OTHER: '기타',
};

const HEADER = [
  '피해유형', '피해유형코드', '원인후보', '원인코드', '확인경로',
  '함께적힌건수', '해외리콜사건수', '비율', '향상도', '계산일',
] as const;

/**
 * GET /api/codebook/cause-bridge/export — 결과 → 원인 다리를 CSV 로 내려준다
 *
 * 확인 경로로 거르지 않고 다 내보낸다. 담당자가 엑셀에서 "법령" 줄만 따로 모아
 * 인증·표시 점검 목록으로 쓸 수 있어야 하기 때문이다.
 */
export async function GET() {
  const rows = await loadBridge();
  const csv = toCsv(HEADER, rows.map((r) => [
    r.dtName ?? '', r.dtCode, r.hfName ?? '', r.hfCode, ROUTE_KO[r.route],
    r.support, r.sampleSize, (r.confidence * 100).toFixed(1) + '%', r.lift.toFixed(2),
    r.computedAt.slice(0, 10),
  ]));
  return csvResponse(csv, 'cause-bridge');
}
