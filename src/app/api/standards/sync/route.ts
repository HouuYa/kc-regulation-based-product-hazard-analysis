/**
 * POST /api/standards/sync — 안전기준 폴더 동기화 라우트
 *
 * 지금은 아무도 이 라우트를 자동으로 호출하지 않는다. npm run standards:load 로
 * 충분하기 때문이다. 그런데도 지금 만들어 두는 이유는, 나중에 "새 JSON 이 오면
 * 자동으로 반영" 하는 경로(예: n8n 이 협회 갱신을 감지해 호출, 또는 관리 화면의
 * 버튼)가 생겼을 때 그 경로가 부를 자리가 미리 있어야 하기 때문이다.
 * 로직은 src/lib/standards/sync.ts 에 있고, 이 라우트는 그것을 HTTP 로 노출할 뿐이다.
 *
 * 인증
 *   0단계는 사용자 인증 체계를 만들지 않는다(§9). 그렇다고 완전히 열어 두면
 *   외부에서 아무나 대량 쓰기 작업을 트리거할 수 있으므로, 토큰이 설정돼 있으면
 *   검사하고 없으면(로컬 개발 단계) 통과시킨다. 나중에 n8n 웹훅으로 연결할 때
 *   STANDARDS_SYNC_TOKEN 을 실제로 채우면 그 시점부터 잠긴다.
 */

import { NextResponse } from 'next/server';
import { syncStandardsFolder } from '@/lib/standards/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const token = process.env.STANDARDS_SYNC_TOKEN;
  if (!token) return true; // 토큰 미설정 — 로컬 개발 단계로 간주
  return req.headers.get('authorization') === `Bearer ${token}`;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: '인증 실패' }, { status: 401 });
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
