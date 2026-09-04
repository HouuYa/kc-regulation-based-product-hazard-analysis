import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { ActionForm } from '@/components/ActionForm';
import { BoardToolbar, BoardPager, parseBoard, type BoardParams } from '@/components/Board';
import { reviewTerm, addTerm, deleteTerm } from './actions';
import { TermImport } from './TermImport';

export const dynamic = 'force-dynamic';

/**
 * 품목 용어 사전
 *
 * 왜 이 화면이 필요한가
 *   이 사전이 기준 선택을 좌우한다. 사고보고서 70건에서 품목 확정이
 *   7건(10%) → 58건(83%)이 된 것이 이 사전 덕이다. 그만큼 틀리면 크게 틀린다 —
 *   잘못된 기준이 붙으면 다른 제품의 시험이 담당자에게 근거로 제시된다.
 *
 *   그런데 AI 가 찾아낸 대응이 계속 미검수로 쌓인다. 확정·반려할 자리가 없으면
 *   사전이 검토되지 않은 채 자란다.
 *
 * 왜 내보내기·가져오기가 있는가
 *   담당자는 실제로 엑셀로 일한다 — 이 프로젝트의 정답지도 엑셀로 받았다.
 *   한 건씩 화면에서 고치는 것보다 내려받아 한꺼번에 손보고 되돌려 넣는 쪽이
 *   훨씬 빠르다. 그 길이 없으면 이 사전은 결국 안 쓰이게 된다.
 *
 * 왜 GPC 를 함께 보여 주는가 (그런데 기준 선택에는 안 쓴다)
 *   GPC 는 사고와 리콜을 같은 품목군으로 묶는 데 쓴다 — 해외 리콜은 영어로,
 *   우리 사고는 한국어로 적히므로 언어에 독립적인 키가 필요하다.
 *
 *   기준 선택에는 쓸 수 없다. 담당자가 만든 엑셀을 세어 보니 한 브릭이 여러 품목을
 *   묶는 4건 중 3건에서 기준이 서로 달랐다(10000759 개인용 온열/마사지용품 →
 *   눈마사지기·손목마사지기·전기찜질기의 기준이 제각각). GPC 는 유통 분류이고
 *   KC 기준은 위해·기능 분류라 축이 다르다.
 */

interface TermRow {
  term_key: string;
  term: string;
  standard_count: number;
  standards: string[];
  has_expert: boolean;
  unreviewed_count: number;
  brick_code: string | null;
  brick_title_ko: string | null;
  brick_title_en: string | null;
}

async function load(params: BoardParams) {
  const db = getDb();
  const { q, page } = parseBoard(params, 'term');
  const per = 25;
  const skip = (page - 1) * per;
  const only = params.status ?? '';

  const where = db`
    where 1 = 1
      ${q ? db`and (v.term ilike ${'%' + q + '%'}
                    or exists (select 1 from unnest(v.standards) s where s ilike ${'%' + q + '%'}))` : db``}
      ${only === 'unreviewed' ? db`and v.unreviewed_count > 0` : db``}
      ${only === 'expert' ? db`and v.has_expert` : db``}
      ${only === 'no_gpc' ? db`and v.brick_code is null` : db``}
  `;

  const [[summary], [{ total }], rows, stds] = await Promise.all([
    db<{ terms: number; unreviewed: number; expert: number; withGpc: number }[]>`
      select
        (select count(*)::int from public.scope_term_view)                              as terms,
        (select count(*)::int from public.scope_term_view where unreviewed_count > 0)   as unreviewed,
        (select count(*)::int from public.scope_term_view where has_expert)             as expert,
        (select count(*)::int from public.scope_term_view where brick_code is not null) as "withGpc"
    `,
    db<{ total: number }[]>`select count(*)::int as total from public.scope_term_view v ${where}`,
    db<TermRow[]>`
      select v.term_key, v.term, v.standard_count, v.standards, v.has_expert,
             v.unreviewed_count, v.brick_code, v.brick_title_ko, v.brick_title_en
      from public.scope_term_view v
      ${where}
      order by v.unreviewed_count desc, v.term
      limit ${per} offset ${skip}
    `,
    db<{ display_name: string }[]>`
      select display_name from public.standard where is_current order by display_name
    `,
  ]);

  return { summary, rows, total, page, per, standards: stds.map((s) => s.display_name) };
}

export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<BoardParams>;
}) {
  const params = await searchParams;

  let data: Awaited<ReturnType<typeof load>> | null = null;
  let error: string | null = null;
  try {
    data = await load(params);
  } catch (e) {
    console.error('용어 사전 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="참고"
        title="품목 용어 사전"
        lead="사고보고서에 적히는 일상 용어를 어느 안전기준으로 이을지 정해 둡니다. 이 사전이 분석의 출발점입니다."
      />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          <StatusBar
            items={[
              { label: '등록된 품목', value: data.summary.terms },
              { label: '담당자 확정', value: data.summary.expert, of: data.summary.terms },
              { label: '검수 대기', value: data.summary.unreviewed, wantsZero: true },
              { label: 'GPC 연결', value: data.summary.withGpc, of: data.summary.terms },
            ]}
          />

          <div className="mt-4 border border-rule-soft px-4 py-3 text-[12px] leading-relaxed text-ink-2">
            <span className="text-ink">적용기준</span>은 분석에서 어느 기준을 뒤질지 정합니다.{' '}
            <span className="text-ink">GPC</span>는 사고와 리콜을 같은 품목군으로 묶어 셀 때만 씁니다 —
            기준 선택에는 쓰지 않습니다. 같은 GPC 품목군 안에서도 제품마다 적용 기준이 다르기 때문입니다.
          </div>

          {/* ── 내보내기 · 가져오기 ─────────────────────────── */}
          <section className="mt-8 border border-rule px-4 py-4">
            <div className="text-[13px] font-semibold">엑셀로 한꺼번에 손보기</div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
              내려받아 엑셀에서 고친 뒤 다시 올리면 됩니다. 올리기 전에 무엇이 바뀌는지 먼저 보여 드립니다 —
              사전이 조용히 바뀌면 검색 결과도 조용히 바뀌기 때문입니다.
            </p>
            <div className="mt-3 flex flex-wrap items-start gap-3">
              <a
                href="/api/terms/export"
                className="inline-block border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft"
              >
                CSV 내려받기
              </a>
              <TermImport />
            </div>
          </section>

          {/* ── 직접 추가 ───────────────────────────────────── */}
          <section className="mt-6 border border-rule px-4 py-4">
            <div className="text-[13px] font-semibold">품목 직접 추가</div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
              사전에 없는 품목을 넣습니다. 담당자가 넣은 것은 바로 확정 상태가 됩니다.
            </p>
            <form action={addTerm as unknown as (fd: FormData) => void} className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="text" name="term" required placeholder="품목명 (예: 전기요)"
                className="min-w-[10rem] border border-rule bg-surface px-3 py-2 text-[13px]"
              />
              <input
                type="text" name="standard" required list="std-list" placeholder="적용기준"
                className="min-w-[16rem] border border-rule bg-surface px-3 py-2 text-[13px]"
              />
              <datalist id="std-list">
                {data.standards.map((s) => <option key={s} value={s} />)}
              </datalist>
              <input
                type="text" name="reviewer" placeholder="작성자 (선택)"
                className="w-28 border border-rule bg-surface px-3 py-2 text-[13px]"
              />
              <button type="submit" className="border border-measure bg-measure px-4 py-2 text-[13px] font-medium text-white hover:opacity-85">
                추가
              </button>
            </form>
          </section>

          <BoardToolbar
            basePath="/terms"
            params={params}
            placeholder="품목명 또는 기준으로 찾기"
            filters={[{
              name: 'status', label: '거르기',
              options: [
                { value: '', label: '전체' },
                { value: 'unreviewed', label: '검수 대기만' },
                { value: 'expert', label: '담당자 확정만' },
                { value: 'no_gpc', label: 'GPC 없는 것만' },
              ],
            }]}
          />

          {data.rows.length === 0 ? (
            <EmptyState message="조건에 맞는 품목이 없습니다." />
          ) : (
            <section className="mt-6">
              {data.rows.map((r) => (
                <article key={r.term_key} className="border-t border-rule py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="text-[14px] font-semibold">{r.term}</span>
                    <span className="text-[11px]">
                      {r.unreviewed_count > 0
                        ? <span className="text-caution">검수 대기 {r.unreviewed_count}건</span>
                        : r.has_expert
                          ? <span className="text-measure">담당자 확정</span>
                          : <span className="text-ink-3">확정됨</span>}
                    </span>
                  </div>

                  <div className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                    적용기준 {r.standard_count}종 — <span className="addr">{r.standards.join(', ')}</span>
                  </div>

                  <div className="mt-1 text-[11px] text-ink-3">
                    {r.brick_code
                      ? <>GPC <span className="addr">{r.brick_code}</span> {r.brick_title_ko ?? r.brick_title_en}</>
                      : 'GPC 연결 없음 — 사고·리콜 교차 집계에서 이 품목은 묶이지 않습니다'}
                  </div>

                  <div className="mt-3 flex flex-wrap items-start gap-2">
                    {r.unreviewed_count > 0 && (
                      <ActionForm
                        action={reviewTerm}
                        hidden={{ termKey: r.term_key, toStatus: 'approved' }}
                        label="확정"
                        pendingLabel="확정하는 중…"
                        className="border border-measure bg-measure px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-85"
                      />
                    )}
                    <ActionForm
                      action={reviewTerm}
                      hidden={{ termKey: r.term_key, toStatus: 'rejected' }}
                      label="반려"
                      pendingLabel="반려하는 중…"
                      className="border border-rule bg-surface px-3 py-1.5 text-[12px] hover:bg-rule-soft"
                    />
                    <ActionForm
                      action={deleteTerm}
                      hidden={{ termKey: r.term_key }}
                      label="삭제"
                      pendingLabel="지우는 중…"
                      className="border border-rule bg-surface px-3 py-1.5 text-[12px] text-ink-3 hover:bg-rule-soft"
                    />
                  </div>
                </article>
              ))}

              <div className="mt-6">
                <BoardPager basePath="/terms" params={params} page={data.page} per={data.per} total={data.total} />
              </div>
            </section>
          )}

          <p className="mt-8 text-[11px] leading-relaxed text-ink-3">
            반려와 삭제는 다릅니다. <span className="text-ink-2">반려</span>는 &ldquo;아니다&rdquo;라는 판단을 기록으로 남기고,{' '}
            <span className="text-ink-2">삭제</span>는 흔적을 없앱니다. 잘못 넣은 것은 지우고, 검토해서 아니라고
            판단한 것은 반려하는 것이 맞습니다.
          </p>

          <p className="mt-4 text-[12px] text-ink-3">
            <Link href="/standards" className="underline decoration-rule underline-offset-2 hover:text-measure">
              안전기준 화면으로
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
