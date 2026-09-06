import { exportKeywordsCsv } from '@/lib/terms/keyword-csv';
import { csvResponse } from '@/lib/csv';

export const dynamic = 'force-dynamic';

/**
 * GET /api/keywords/export — 품목 검색어 사전을 CSV 로 내려준다
 *
 * 반려된 것까지 모두 내보낸다. 담당자가 엑셀에서 "왜 이건 반려했더라"를 되짚을 수
 * 있어야 하고, 되돌리는 것도 파일에서 상태만 고쳐 다시 올리면 되기 때문이다.
 */
export async function GET() {
  return csvResponse(await exportKeywordsCsv(), 'item-keywords');
}
