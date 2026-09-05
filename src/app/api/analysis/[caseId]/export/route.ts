import { exportAnalysisCsv } from '@/lib/search/export';
import { csvResponse } from '@/lib/csv';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analysis/[caseId]/export — 분석 결과를 CSV 로 내려준다
 *
 * ?cause=HF.H.ELEC.INS&cause=… 를 함께 주면 원인으로 찾은 목록도 담는다.
 * 화면의 주소에 그대로 실려 있으므로, 화면에서 본 것과 파일이 어긋나지 않는다.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId: raw } = await params;
  const caseId = Number(raw);
  if (!caseId) return new Response('사건을 찾지 못했습니다.', { status: 400 });

  const picked = new URL(req.url).searchParams.getAll('cause').filter(Boolean);
  const csv = await exportAnalysisCsv(caseId, picked);
  return csvResponse(csv, `analysis-${caseId}`);
}
