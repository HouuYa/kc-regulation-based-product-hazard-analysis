import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { loadRecalls } from '@/lib/recall/load';
import { syncStandardsFolder } from '@/lib/standards/sync';
import { runTagging, countTaggable } from '@/lib/standards/tag-run';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 자동 실행 진입점 — "npm run 을 꼭 로컬에서 해야 하나"에 대한 답
 *
 * 담당자 질문이 출발점이다. 조사해 보니 스크립트마다 답이 달랐다.
 *
 *   리콜 수집      로컬 파일 없음, 외부 표만 읽음 → 자동으로 돌려도 된다
 *   기준 폴더 동기화 KC안전기준/ 가 저장소에 있음     → 자동으로 돌려도 된다
 *   조항 코드 부여  로컬 파일 없음이지만 돈이 든다   → 사람이 눌러야 한다
 *   사고보고서 적재 원본 PDF 가 개인정보라 저장소에 없음 → 로컬에서만 가능
 *   정확도 평가    사람이 손으로 채운 정답지가 필요   → 로컬에서만 가능
 *
 * 그래서 앞의 셋만 여기에 노출한다. 뒤의 둘은 클라우드에 올릴 재료 자체가 없다.
 *
 * 왜 pg_cron 이 이 라우트를 부르는가 (Edge Function 이 아니라)
 *   라운드 17에서 임베딩 자동화를 pg_cron + pg_net 으로 만들어 두었고 잘 돌고 있다.
 *   같은 방식을 쓰면 새로 배울 것도, 새로 고장 날 것도 없다. 다만 임베딩과 달리
 *   이 작업들은 TypeScript 로직이 두꺼워서 SQL 로 옮겨 적을 수 없다 — 그래서
 *   DB 가 이 HTTP 라우트를 부르고, 로직은 src/lib 의 것을 그대로 쓴다.
 *
 * 인증
 *   사이트 전체를 막는 ID/PW(미들웨어)는 이 경로에 적용되지 않는다. DB 가 부를 때
 *   사람의 비밀번호를 쓸 수는 없기 때문이다. 대신 JOBS_TOKEN 을 요구한다.
 *   토큰이 설정돼 있지 않으면 아무도 부를 수 없게 막는다 — 다른 라우트처럼
 *   "미설정이면 통과"로 두면 대량 쓰기 작업이 인터넷에 열린 채로 있게 된다.
 */

type JobName = 'recalls-fetch' | 'standards-sync' | 'tag-chunk';

const JOBS: JobName[] = ['recalls-fetch', 'standards-sync', 'tag-chunk'];

/**
 * 코드 부여 한 번에 쓸 시간.
 *
 * 배포 환경의 요청 시간 제한은 30초다(실측: 31초에 504 Inactivity Timeout).
 *
 * 예산은 "새 조항을 시작할지"만 정한다. 이미 시작한 건은 끝까지 기다리므로
 * 전체 요청 시간은 예산 + 조항 1건 시간 + 기동 시간이다. 조항 1건이 약 7초,
 * 기동이 약 5초이므로 12초로 잡으면 전체가 24초 안팎에서 끝난다.
 *
 * 처음에는 25초로 잡았다가 504 를 맞았다. 그때는 조항 1건이 18초여서
 * 예산을 낮춰도 소용이 없었는데, 반복 호출을 동시에 보내도록 고쳐(tagging.ts)
 * 1건이 7초가 되면서 비로소 여유가 생겼다.
 */
const TAG_TIME_BUDGET_MS = 12_000;

/**
 * 자동 실행일 때만 동시 처리를 올린다.
 *
 * 화면 버튼은 담당자가 결과를 기다리므로 응답이 빨라야 하고, 자동 실행은
 * 아무도 안 기다리므로 처리량이 중요하다. 같은 함수를 다르게 쓴다.
 */
const TAG_CONCURRENCY = 6;

function authorized(req: Request): boolean {
  const token = process.env.JOBS_TOKEN?.trim();
  if (!token) return false;
  return req.headers.get('authorization') === `Bearer ${token}`;
}

/** 끝나고 담당자에게 알린다. 알림이 실패해도 작업 결과는 그대로 둔다 */
async function notify(kind: string, body: string): Promise<void> {
  try {
    await getDb()`select public.ops_notify(${kind}, ${body}, interval '30 minutes')`;
  } catch (e) {
    console.error('알림 발송 실패:', e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ job: string }> }) {
  if (!authorized(req)) {
    return NextResponse.json({ error: '인증 실패' }, { status: 401 });
  }

  const { job } = await ctx.params;
  if (!JOBS.includes(job as JobName)) {
    return NextResponse.json({ error: `모르는 작업: ${job}`, known: JOBS }, { status: 404 });
  }

  const started = Date.now();

  try {
    if (job === 'recalls-fetch') {
      const params = new URL(req.url).searchParams;
      const limit = Number(params.get('limit') ?? '20') || 20;
      const offset = Number(params.get('offset') ?? '0') || 0;
      const r = await loadRecalls({ limit, offset });
      if (r.newCase > 0) {
        await notify(
          '리콜 수집',
          `새 리콜 ${r.newCase}건이 들어왔습니다. (전체 조회 ${r.received}건 · 기존 ${r.existingCase}건)\n` +
            `위해요인 코드 부여 ${r.tagged}건 · 품목 확정 ${r.resolved}건`,
        );
      }
      return NextResponse.json({
        job, ok: true, elapsedMs: Date.now() - started,
        offset, limit,
        received: r.received, newCase: r.newCase, existingCase: r.existingCase,
        tagged: r.tagged, resolved: r.resolved,
        llmReclassified: r.llmReclassified.length, unclassified: r.unclassified.length,
      });
    }

    if (job === 'standards-sync') {
      const params = new URL(req.url).searchParams;
      const limit = Number(params.get('limit') ?? '20') || 20;
      const offset = Number(params.get('offset') ?? '0') || 0;
      const results = await syncStandardsFolder({ offset, limit });
      const added = results.filter((r) => r.status === 'new').length;
      const updated = results.filter((r) => r.status === 'updated').length;
      const failed = results.filter((r) => r.status === 'error').length;
      if (added + updated > 0) {
        await notify(
          '안전기준 갱신',
          `새 기준 ${added}건 · 개정 ${updated}건이 반영됐습니다.\n` +
            '조항에 위해요인 코드를 부여해야 검색에 온전히 잡힙니다.',
        );
      }
      return NextResponse.json({
        job, ok: true, elapsedMs: Date.now() - started,
        offset, limit,
        added, updated, failed, total: results.length,
      });
    }

    // tag-chunk — 1분마다 이어서 하는 작업(026)과 화면 버튼이 함께 부른다.
    // 주기는 걸려 있지만 기본이 꺼짐이라, 담당자가 켜야 돈다(비용이 들기 때문).
    // 병렬로 도는 다른 요청과 겹치지 않도록 맡은 구간을 받는다(027)
    const offset = Number(new URL(req.url).searchParams.get('offset') ?? '0') || 0;

    const before = await countTaggable();
    const r = await runTagging({
      timeBudgetMs: TAG_TIME_BUDGET_MS,
      concurrency: TAG_CONCURRENCY,
      offset,
      // 구간 안에서만 고르면 되므로 목록 전체를 읽어 올 이유가 없다
      limit: 40,
    });
    const after = await countTaggable();

    if (after === 0 && before > 0) {
      await notify('코드 부여 완료', '모든 요건 조항에 위해요인 코드가 부여됐습니다.');
    }

    return NextResponse.json({
      job, ok: true, elapsedMs: Date.now() - started,
      offset, done: r.ok, failed: r.fail, remaining: after, stoppedEarly: r.stoppedEarly,
      escalated: r.escalated, errors: r.errors.slice(0, 5),
    });
  } catch (e) {
    console.error(`작업 ${job} 실패:`, e);
    return NextResponse.json(
      { job, ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
