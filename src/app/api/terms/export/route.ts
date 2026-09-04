import { exportTermsCsv } from '@/lib/terms/csv';

export const dynamic = 'force-dynamic';

/**
 * GET /api/terms/export — 용어 사전을 CSV 로 내려준다
 *
 * 서버 액션이 아니라 라우트인 이유: 브라우저가 파일로 저장하려면 응답 헤더에
 * Content-Disposition 이 있어야 하는데, 서버 액션은 헤더를 정할 수 없다.
 *
 * 인증은 미들웨어가 맡는다 — /api/jobs/ 를 뺀 모든 경로에 Basic 인증이 걸린다.
 */
export async function GET() {
  const csv = await exportTermsCsv();
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="scope-terms-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
