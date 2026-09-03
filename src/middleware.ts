import { NextRequest, NextResponse } from 'next/server';

/**
 * 사이트 전체 접근 차단(외부 차단 목적).
 *
 * SITE_AUTH_PASSWORD 가 설정돼 있지 않으면(로컬 개발 등) 그냥 통과시킨다 —
 * 이 프로젝트의 optional() 환경변수 관례와 같다.
 */
export function middleware(request: NextRequest) {
  // 자동 실행 경로는 사람이 아니라 데이터베이스가 부른다. 사람의 ID/PW 를 쓸 수
  // 없으므로 여기서는 통과시키고, 그 라우트가 자체 토큰(JOBS_TOKEN)으로 지킨다.
  // 토큰이 없으면 그 라우트는 아무도 못 부르게 막는다 — 열린 채로 두지 않는다.
  if (request.nextUrl.pathname.startsWith('/api/jobs/')) {
    return NextResponse.next();
  }

  const expectedUser = process.env.SITE_AUTH_USERNAME;
  const expectedPass = process.env.SITE_AUTH_PASSWORD;

  if (!expectedPass) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get('authorization');

  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const separatorIndex = decoded.indexOf(':');
    const user = decoded.slice(0, separatorIndex);
    const pass = decoded.slice(separatorIndex + 1);

    if ((!expectedUser || user === expectedUser) && pass === expectedPass) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="KC Hazard Analysis"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
