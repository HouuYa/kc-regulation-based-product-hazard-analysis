import { exportStopwordsCsv } from '@/lib/terms/keyword-csv';
import { csvResponse } from '@/lib/csv';

export const dynamic = 'force-dynamic';

/**
 * GET /api/keywords/stopwords — 품목 매칭에서 빼야 할 말을 CSV 로 내려준다
 *
 * 검색어 사전과 짝이다. 우리 코드는 검색어를 쓸 때 늘 이 목록을 빼는데, 밖에서
 * 검색어만 받아 가면 그 규칙을 모른 채 쓰게 되어 우리보다 넓게 매칭된다.
 */
export async function GET() {
  return csvResponse(await exportStopwordsCsv(), 'item-keyword-stopwords');
}
