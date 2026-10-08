import { getDb } from '@/lib/db';
import { ConnectionError, EmptyState, FlowChart } from '@/components/Panel';
import { ActionForm } from '@/components/ActionForm';
import { reviewLink } from './keyword-actions';
import { ReviewShortcuts } from '@/components/ReviewShortcuts';

/**
 * 품목 판정 사전 「품목→기준」 탭 — 법정 품목 → 적용 기준 (taxonomy_standard, 049)
 *
 * 예전에는 검색어 사전 안의 `?view=link`에 숨어 있었다. 검색어 검수와 섞여 있으니
 * 기준 담당자가 이 검수가 있는 줄도 몰랐다(05 §4.4). 그래서 탭으로 꺼냈다.
 * 다만 검색어와 같은 server action(keyword-actions.ts reviewLink)을 그대로 쓴다.
 */

const PAGE = 40;

interface LinkRow {
  id: number;
  item_group: string;
  target: string;
  display_name: string | null;
  title_ko: string | null;
  scope_text: string;
  confidence: string | null;
  evidence: string | null;
  review_status: string;
  used_by: number;
}

async function load(params: { view?: string; q?: string }) {
  const db = getDb();
  const view = params.view === 'nomatch' ? 'nomatch' : 'link';
  const q = (params.q ?? '').trim();

  /*
    적용범위·제목을 뜻으로 견주어 만든 것이다. 검수 순서는 두 가지로 정한다 —
    **실제 사고·리콜에 걸리는 품목**이 먼저이고, 그중 **확신이 낮은 것**이 먼저다.
    확신 99% 짜리를 먼저 보여 주면 담당자가 지루해져 정작 위험한 것에 눈이 무뎌진다.
  */
  const links = await db<LinkRow[]>`
    select
      x.id, x.item_group, coalesce(x.sub_item, x.item, '') target,
      s.display_name, s.title_ko,
      left(coalesce(s.scope_text, ''), 200) scope_text,
      x.confidence::text, x.evidence, x.review_status,
      coalesce((
        select count(distinct ce.id)::int
        from public.item_keyword k
        join public.case_event ce on public.scope_term_key(ce.item_name) = k.keyword_key
        where k.item_group = x.item_group
          and coalesce(k.sub_item, k.item, '') = coalesce(x.sub_item, x.item, '')
          and k.review_status <> 'rejected' and ce.item_name is not null
      ), 0) used_by
    from public.taxonomy_standard x
    -- 기준을 못 찾은 줄은 standard_id 가 비어 있다(050). left join 이라야 그 줄도 나온다
    left join public.standard s on s.id = x.standard_id
    where ${q ? db`(coalesce(x.sub_item, x.item, '') ilike ${'%' + q + '%'} or s.display_name ilike ${'%' + q + '%'})` : db`true`}
      ${view === 'nomatch' ? db`and x.standard_id is null` : db`and x.standard_id is not null`}
    order by
      (x.review_status = 'auto_unreviewed') desc,
      used_by desc,
      x.confidence asc nulls first
    limit ${PAGE}
  `;

  return { links, view };
}

export async function LinkTab({ params }: { params: { view?: string; q?: string } }) {
  let data: Awaited<ReturnType<typeof load>> | null = null;
  let error: string | null = null;
  try {
    data = await load(params);
  } catch (e) {
    console.error('품목→기준 탭 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  const view = data?.view ?? 'link';
  const tab = (v: string, label: string, hint?: string) => (
    <a
      key={v}
      href={`/dictionary?tab=link&view=${v}`}
      className={`border px-3 py-1.5 text-[12px] ${
        view === v ? 'border-ink bg-ink text-surface' : 'border-rule hover:bg-rule-soft'
      }`}
      title={hint}
    >
      {label}
    </a>
  );

  return (
    <>
      {/*
        「리콜에서 기준까지 가는 길」의 다리 2 다. 다리 1(검색어)이 법정 품목까지
        데려다주면, 여기서 정한 기준이 붙는다.
      */}
      <FlowChart steps={[
        { label: '일상어', note: '천장등', state: 'done' },
        { label: '다리 1 · 검색어', href: '/dictionary?tab=keyword', note: '검색어 탭', state: 'done' },
        { label: '법정 품목', note: 'LED등기구', state: 'done' },
        { label: '다리 2 · 품목→기준', who: '사람', note: '이 탭', state: 'here' },
        { label: 'KC안전기준', note: 'KC 60598-2-4', state: 'todo' },
      ]} />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          <div className="mt-5 flex flex-wrap gap-2">
            {tab('link', '법정 품목 → 기준', '적용범위·제목을 뜻으로 견주어 이은 것')}
            {tab('nomatch', '이을 기준 없음', '이을 기준을 못 찾은 품목과 그 사유')}
          </div>

          {/*
            행 단위로 판단하는 화면이라 단축키를 붙인다. 판단을 줄이는 장치가 아니라
            버튼을 찾아 누르는 손동작만 줄이는 장치다.
          */}
          <ReviewShortcuts />
          <p className="mt-3 text-[11px] text-ink-3">
            키보드로도 됩니다 — <span className="text-ink-2">j·↓</span> 다음 ·{' '}
            <span className="text-ink-2">k·↑</span> 이전 ·{' '}
            <span className="text-ink-2">a</span> 확정 ·{' '}
            <span className="text-ink-2">r</span> 반려. 판단은 한 건씩 그대로 하시고,
            버튼을 찾아 누르는 수고만 덜어 드립니다.
          </p>

          <section className="mt-6">
            <div className="border border-rule-soft px-4 py-3 text-[12px] leading-relaxed text-ink-2">
              검색어가 <span className="text-ink">법정 품목</span>까지 데려다주면, 그다음은 그 품목의
              <span className="text-ink"> 적용 기준</span>을 찾아야 합니다. 기준의 적용범위와 제목을
              뜻으로 견주어 이어 둔 것입니다 — 글자로는 187종 중 7종밖에 안 맞습니다.
              <br />
              <span className="text-ink">이 판단은 특히 무겁습니다.</span> 품목이 틀리면 그 품목으로
              이어지는 <strong className="font-semibold">모든</strong> 사고·리콜에 엉뚱한 기준의 시험이
              근거로 제시됩니다. 그래서 실제로 걸리는 품목부터, 그중 확신이 낮은 것부터 보여 줍니다.
            </div>

            {data.links.length === 0 ? (
              <EmptyState message="이어 둔 대응이 없습니다. npm run taxonomy:link 로 만드세요." />
            ) : (
              data.links.map((l) => {
                const pct = l.confidence ? Math.round(Number(l.confidence) * 100) : null;
                return (
                  <article
                    key={l.id}
                    data-review-row
                    tabIndex={0}
                    // 지금 보고 있는 줄을 계측의 색으로만 표시한다. 경고색은 쓰지 않는다
                    className="border-t border-rule py-3.5 focus:bg-measure-soft"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-[14px] font-semibold">{l.target}</span>
                      <span className="text-[12px] text-ink-3">→</span>
                      {l.display_name ? (
                        <span className="addr text-[13px] font-medium">{l.display_name}</span>
                      ) : (
                        <span className="text-[13px] font-medium text-caution">이을 기준을 찾지 못함</span>
                      )}
                      {pct !== null && (
                        <span className={`border px-1.5 text-[10px] ${
                          pct >= 90 ? 'border-rule text-ink-3' : 'border-caution text-caution'
                        }`}>
                          확신 {pct}%
                        </span>
                      )}
                      {l.review_status === 'auto_unreviewed' && (
                        <span className="border border-caution px-1.5 text-[10px] text-caution">미검수</span>
                      )}
                      {l.review_status === 'rejected' && (
                        <span className="border border-rule px-1.5 text-[10px] text-ink-3">반려</span>
                      )}
                      <span className="ml-auto text-[11px] text-ink-3">
                        {l.used_by > 0 ? `사고·리콜 ${l.used_by}건에 걸리는 품목` : l.item_group}
                      </span>
                    </div>

                    {l.title_ko && (
                      <p className="mt-1.5 text-[12px] text-ink-3">기준 제목: {l.title_ko}</p>
                    )}
                    {l.evidence && (
                      <p className="mt-1.5 max-w-3xl border-l-2 border-rule pl-3 text-[12px] leading-relaxed text-ink-2">
                        {l.evidence}
                      </p>
                    )}
                    {l.scope_text && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-[11px] text-ink-3">적용범위 원문 보기</summary>
                        <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-ink-3">
                          {l.scope_text}…
                        </p>
                      </details>
                    )}

                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <ActionForm
                        action={reviewLink}
                        hidden={{ id: String(l.id), toStatus: 'approved' }}
                        label={l.display_name ? '이 기준이 맞다' : '기준이 없는 게 맞다'}
                        pendingLabel="확정하는 중…"
                        hotkeyRole="approve"
                      />
                      <ActionForm
                        action={reviewLink}
                        hidden={{ id: String(l.id), toStatus: 'rejected' }}
                        label={l.display_name ? '아니다 (반려)' : '아니다, 기준이 있다'}
                        pendingLabel="반려하는 중…"
                        hotkeyRole="reject"
                      />
                      {!l.display_name && (
                        <span className="self-center text-[11px] text-ink-3">
                          「기준이 없는 게 맞다」로 확정하면 <strong className="font-semibold">적재해야 할 기준</strong> 목록이 됩니다
                        </span>
                      )}
                    </div>
                  </article>
                );
              })
            )}
          </section>
        </>
      )}
    </>
  );
}
