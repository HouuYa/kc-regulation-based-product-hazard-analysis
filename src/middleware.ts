import { NextRequest, NextResponse } from 'next/server';

/**
 * 사이트 전체 접근 차단(외부 차단 목적).
 *
 * SITE_AUTH_PASSWORD 가 설정돼 있지 않으면(로컬 개발 등) 그냥 통과시킨다 —
 * 이 프로젝트의 optional() 환경변수 관례와 같다.
 */
export function middleware(request: NextRequest) {
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
