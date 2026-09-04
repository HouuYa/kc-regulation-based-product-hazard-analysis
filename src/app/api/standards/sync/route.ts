/**
 * POST /api/standards/sync — 안전기준 폴더 동기화 라우트
 *
 * 지금은 아무도 이 라우트를 자동으로 호출하지 않는다. npm run standards:load 로
 * 충분하기 때문이다. 그런데도 지금 만들어 두는 이유는, 나중에 "새 JSON 이 오면
 * 자동으로 반영" 하는 경로(예: n8n 이 협회 갱신을 감지해 호출, 또는 관리 화면의
 * 버튼)가 생겼을 때 그 경로가 부를 자리가 미리 있어야 하기 때문이다.
 * 로직은 src/lib/standards/sync.ts 에 있고, 이 라우트는 그것을 HTTP 로 노출할 뿐이다.
 *
 * 인증 — 토큰이 없으면 아무도 못 부른다 (2026-09-04 변경)
 *
 *   전에는 "토큰이 설정돼 있으면 검사하고 없으면 통과"였다. 그런데 확인해 보니
 *   STANDARDS_SYNC_TOKEN 은 .env.example 에조차 없다. 템플릿대로 환경을 꾸린
 *   사람은 이 값을 넣을 일이 없고, 그러면 인증이 늘 통과한다. 즉 "나중에 채우면
 *   잠긴다"는 전제가 실제로는 성립한 적이 없었다.
 *
 *   그동안 이 경로를 막고 있던 것은 미들웨어의 Basic 인증 하나뿐이다
 *   (src/middleware.ts). SITE_AUTH_PASSWORD 가 빠지는 순간 안전기준 전체
 *   재적재가 인터넷에 열린다.
 *
 *   그래서 /api/jobs/ 와 같은 규칙으로 바꾼다 — 토큰이 없으면 통과가 아니라 차단이다.
 *   기능을 없애지 않으면서 열려 있을 가능성만 없앤다.
 *
 * 이 라우트는 지금 완주하지도 못한다
 *   maxDuration 은 300 이지만 Netlify 프록시는 약 30초에 끊는다. 게다가 아래는
 *   구간을 나누지 않고 폴더 전체(76개)를 한 번에 처리하려 든다. 실제로 쓰려면
 *   /api/jobs/standards-sync 처럼 offset·limit 을 받아야 한다.
 *
 *   지우는 편이 낫다고 보지만, 협회 쪽에서 이 URL 을 이미 부르고 있을 가능성이
 *   있어 담당자 확인 전까지는 잠그기만 한다.
 */

import { NextResponse } from 'next/server';
import { syncStandardsFolder } from '@/lib/standards/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const token = process.env.STANDARDS_SYNC_TOKEN?.trim();
  // 미설정이면 통과가 아니라 차단이다. /api/jobs/[job] 과 같은 규칙
  if (!token) return false;
  return req.headers.get('authorization') === `Bearer ${token}`;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    // 왜 막혔는지 구분해 준다 — 토큰을 안 넣은 것과 틀린 토큰은 대응이 다르다
    const configured = Boolean(process.env.STANDARDS_SYNC_TOKEN?.trim());
    return NextResponse.json(
      {
        error: configured
          ? '인증 실패'
          : 'STANDARDS_SYNC_TOKEN 이 설정돼 있지 않아 이 경로는 잠겨 있습니다.',
      },
      { status: 401 },
    );
  }

  const only = new URL(req.url).searchParams.get('only') ?? undefined;

  let results;
  try {
    results = await syncStandardsFolder({ only });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  const summary = {
    new: results.filter((r) => r.status === 'new').length,
    updated: results.filter((r) => r.status === 'updated').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    error: results.filter((r) => r.status === 'error').length,
  };

  return NextResponse.json({ summary, results });
}
