import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { ActionForm } from '@/components/ActionForm';
import { riskSummary, riskyKeywords, type KeywordRisk } from '@/lib/terms/keyword-check';
import { reviewKeyword, reviewTarget, addKeyword, deleteKeyword, suggestForTarget, reviewLink } from './actions';
import { KeywordImport } from './KeywordImport';

export const dynamic = 'force-dynamic';

/**
 * 화면 — 품목 검색어 사전 (일상어 → 법정 품목)
 *
 * 이 사전이 하는 일
 *   "천장등"이 「조명기기 > 일반조명기구 > LED등기구」임을 알아야 적용 기준을 찾을 수
 *   있다. 사고보고서는 담당자가 쓰는 글이라 법정어가 84%지만, 해외 리콜 1,553종은
 *   6%만 법정어와 맞는다. 그 간극을 메우는 자리다.
 *
 * 왜 위험 진단을 앞에 두는가
 *   검색어가 5,982개이고 그중 4,943개가 AI 제안이다. 담당자가 하나씩 볼 수 없다.
 *   그런데 전부가 똑같이 급하지는 않다 —
 *
 *     실제 사고·리콜 품목명에 걸리는 것   382개   지금 결과를 바꾸고 있다
 *     여러 품목에 걸쳐 있는 것(충돌)     600개   어느 품목인지 정할 수 없다
 *     나머지                          약 5,000개  아직 아무것도 안 걸린다
 *
 *   그래서 **실제로 걸리면서 충돌하는 것**을 맨 위에 놓는다. 담당자 시간이 이 체계에서
 *   가장 비싼 자원이다.
 *
 * 확정 전에는 쓰이지 않는다
 *   AI 제안은 검수를 통과해야 품목 확정에 쓰인다. 별칭이 틀리면 엉뚱한 품목으로
 *   인식되고 엉뚱한 기준의 시험이 근거로 제시된다 — 조용히 틀리는 종류의 고장이다.
 */

const PAGE = 40;

interface LinkRow {
  id: number;
  item_group: string;
  target: string;
  display_name: string;
  title_ko: string | null;
  scope_text: string;
  confidence: string | null;
  evidence: string | null;
  review_status: string;
  used_by: number;
}

interface GroupRow {
  item_group: string;
  target: string;
  expert: number;
  llm_approved: number;
  llm_pending: number;
  rejected: number;
  keywords: Array<{ id: number; keyword: string; source: string; review_status: string }>;
  used_by: number;
}

async function load(params: { view?: string; q?: string; page?: string }) {
  const db = getDb();
  const view = params.view ?? 'risk';
  const q = (params.q ?? '').trim();
  const page = Math.max(1, Number(params.page ?? '1') || 1);

  const summary = await riskSummary();

  // 위험 목록 — 손볼 곳부터
  const risks: KeywordRisk[] = view === 'risk' || view === 'conflict'
    ? await riskyKeywords({ onlyConflict: view === 'conflict', limit: 60 })
    : [];

  /*
    법정 품목 → 기준 대응 (049)

    적용범위·제목을 뜻으로 견주어 만든 것이다. 검수 순서는 두 가지로 정한다 —
    **실제 사고·리콜에 걸리는 품목**이 먼저이고, 그중 **확신이 낮은 것**이 먼저다.
    확신 99% 짜리를 먼저 보여 주면 담당자가 지루해져 정작 위험한 것에 눈이 무뎌진다.
  */
  const links = view === 'link' ? await db<LinkRow[]>`
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
    join public.standard s on s.id = x.standard_id
    where ${q ? db`(coalesce(x.sub_item, x.item, '') ilike ${'%' + q + '%'} or s.display_name ilike ${'%' + q + '%'})` : db`true`}
    order by
      (x.review_status = 'auto_unreviewed') desc,
      used_by desc,
      x.confidence asc nulls first
    limit ${PAGE}
  ` : [];

  // 품목 단위 목록 — 검수는 품목 단위로 하는 편이 빠르다
  const groups = view === 'risk' || view === 'conflict' || view === 'link' ? [] : await db<GroupRow[]>`
    with live as (
      select id, item_group, coalesce(sub_item, item, '') target,
             keyword, keyword_key, source, review_status
      from public.item_keyword
    ),
    used as (
      select l.item_group, l.target, count(distinct ce.id)::int n
      from live l
      join public.case_event ce on public.scope_term_key(ce.item_name) = l.keyword_key
      where l.review_status <> 'rejected' and ce.item_name is not null
      group by 1, 2
    )
    select
      l.item_group, l.target,
      count(*) filter (where l.source = 'EXPERT')::int expert,
      count(*) filter (where l.source = 'LLM' and l.review_status = 'approved')::int llm_approved,
      count(*) filter (where l.source = 'LLM' and l.review_status = 'auto_unreviewed')::int llm_pending,
      count(*) filter (where l.review_status = 'rejected')::int rejected,
      coalesce(max(u.n), 0)::int used_by,
      (array_agg(json_build_object(
         'id', l.id, 'keyword', l.keyword, 'source', l.source, 'review_status', l.review_status
       ) order by (l.source = 'EXPERT') desc, l.keyword))[1:40] keywords
    from live l
    left join used u on u.item_group = l.item_group and u.target = l.target
    where ${q
      ? db`(l.target ilike ${'%' + q + '%'} or l.keyword ilike ${'%' + q + '%'})`
      : db`true`}
      ${view === 'pending' ? db`and l.review_status = 'auto_unreviewed'` : db``}
      ${view === 'expert' ? db`and l.source = 'EXPERT'` : db``}
    group by l.item_group, l.target
    order by coalesce(max(u.n), 0) desc, count(*) filter (where l.review_status = 'auto_unreviewed') desc, l.target
    limit ${PAGE} offset ${(page - 1) * PAGE}
  `;

  return { summary, risks, links, groups, view, q, page };
}

const SOURCE_BADGE: Record<string, { text: string; cls: string }> = {
  EXPERT: { text: '담당자', cls: 'border-measure text-measure' },
  LLM: { text: 'AI', cls: 'border-rule text-ink-3' },
};

function KeywordChip({ k }: { k: { id: number; keyword: string; source: string; review_status: string } }) {
  const rejected = k.review_status === 'rejected';
  const pending = k.review_status === 'auto_unreviewed';
  return (
    <span
      className={`inline-flex items-baseline gap-1 border px-1.5 py-0.5 text-[11px] ${
        rejected ? 'border-rule text-ink-3 line-through'
          : pending ? 'border-caution text-caution' : 'border-rule text-ink-2'
      }`}
      title={`${SOURCE_BADGE[k.source]?.text ?? k.source} · ${
        rejected ? '반려' : pending ? '미검수' : '확정'}`}
    >
      {k.keyword}
      {k.source === 'LLM' && <span className="text-[9px] text-ink-3">AI</span>}
    </span>
  );
}

export default async function KeywordsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; page?: string }>;
}) {
  const params = await searchParams;

  let data: Awaited<ReturnType<typeof load>> | null = null;
  let error: string | null = null;
  try {
    data = await load(params);
  } catch (e) {
    console.error('검색어 사전 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  const view = data?.view ?? 'risk';
  const tab = (v: string, label: string, hint?: string) => (
    <a
      key={v}
      href={`/keywords?view=${v}`}
      className={`border px-3 py-1.5 text-[12px] ${
        view === v ? 'border-ink bg-ink text-surface' : 'border-rule hover:bg-rule-soft'
      }`}
      title={hint}
    >
      {label}
    </a>
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="참고"
        title="품목 검색어 사전"
        lead="사고보고서와 해외 리콜에 적히는 일상 용어를 법정 품목으로 잇습니다. 여기서 이어야 그다음에 적용 기준을 찾습니다."
      />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          <StatusBar
            items={[
              { label: '검색어', value: data.summary.total },
              { label: '실제로 걸리는 것', value: data.summary.used, of: data.summary.total },
              { label: '여러 품목에 걸침', value: data.summary.conflicts, wantsZero: true },
              { label: '검수 대기', value: data.summary.unreviewed, wantsZero: true },
            ]}
          />

          <div className="mt-4 border border-rule-soft px-4 py-3 text-[12px] leading-relaxed text-ink-2">
            검색어가 틀리면 <span className="text-ink">엉뚱한 품목</span>으로 인식되고, 그러면
            엉뚱한 기준의 시험이 근거로 제시됩니다. 조용히 틀리는 고장이라 사람이 한 번은 봐야 합니다.
            <span className="text-ink"> AI 제안은 확정하기 전에는 쓰이지 않습니다.</span>
            <br />
            전부가 똑같이 급하지는 않습니다 — <span className="text-ink">실제 품목명에 걸리면서
            여러 품목에 걸쳐 있는 것</span>이 지금 결과를 흔들고 있으므로 그것부터 봅니다.
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {tab('risk', '손볼 곳', '실제로 걸리면서 충돌·과매칭 위험이 있는 것')}
            {tab('conflict', '충돌만', '같은 말이 여러 품목에 붙어 있는 것')}
            {tab('link', '법정 품목 → 기준', '적용범위·제목을 뜻으로 견주어 이은 것')}
            {tab('pending', '검수 대기')}
            {tab('expert', '담당자 사전')}
            {tab('all', '전체')}
          </div>

          {/* ── 법정 품목 → 기준 ───────────────────────────── */}
          {view === 'link' && (
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
                    <article key={l.id} className="border-t border-rule py-3.5">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="text-[14px] font-semibold">{l.target}</span>
                        <span className="text-[12px] text-ink-3">→</span>
                        <span className="addr text-[13px] font-medium">{l.display_name}</span>
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
                          label="이 기준이 맞다"
                          pendingLabel="확정하는 중…"
                        />
                        <ActionForm
                          action={reviewLink}
                          hidden={{ id: String(l.id), toStatus: 'rejected' }}
                          label="아니다 (반려)"
                          pendingLabel="반려하는 중…"
                        />
                      </div>
                    </article>
                  );
                })
              )}
            </section>
          )}

          {/* ── 위험 목록 ─────────────────────────────────── */}
          {(view === 'risk' || view === 'conflict') && (
            <section className="mt-6">
              {data.risks.length === 0 ? (
                <EmptyState message="손볼 곳이 없습니다." />
              ) : (
                data.risks.map((r) => (
                  <article key={r.id} className="border-t border-rule py-3.5">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-[14px] font-semibold">{r.keyword}</span>
                      <span className="text-[12px] text-ink-3">→ {r.target}</span>
                      <span className={`border px-1.5 text-[10px] ${SOURCE_BADGE[r.source]?.cls ?? ''}`}>
                        {SOURCE_BADGE[r.source]?.text ?? r.source}
                      </span>
                      {r.reviewStatus === 'auto_unreviewed' && (
                        <span className="border border-caution px-1.5 text-[10px] text-caution">미검수</span>
                      )}
                      <span className="ml-auto text-[11px] text-ink-3">{r.itemGroup}</span>
                    </div>

                    <div className="mt-2 space-y-1 text-[12px] leading-relaxed">
                      {r.usedBy > 0 && (
                        <p className="text-ink-2">
                          실제 품목명 <span className="addr">{r.usedBy}</span>건에 걸립니다 —{' '}
                          <span className="text-ink-3">{r.usedExamples.join(' · ')}</span>
                        </p>
                      )}
                      {r.otherTargets.length > 0 && (
                        <p className="text-caution">
                          같은 말이 다른 품목에도 붙어 있습니다 — {r.otherTargets.slice(0, 4).join(' | ')}
                          {r.otherTargets.length > 4 && ` 외 ${r.otherTargets.length - 4}개`}
                        </p>
                      )}
                      {r.swallows > 0 && (
                        <p className="text-ink-3">
                          이 말을 품는 다른 검색어가 <span className="addr">{r.swallows}</span>개 있습니다.
                          짧은 말일수록 엉뚱한 품목까지 끌어옵니다
                        </p>
                      )}
                    </div>

                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <ActionForm
                        action={reviewKeyword}
                        hidden={{ id: String(r.id), toStatus: 'approved' }}
                        label="이 품목이 맞다"
                        pendingLabel="확정하는 중…"
                      />
                      <ActionForm
                        action={reviewKeyword}
                        hidden={{ id: String(r.id), toStatus: 'rejected' }}
                        label="아니다 (반려)"
                        pendingLabel="반려하는 중…"
                      />
                      <ActionForm
                        action={deleteKeyword}
                        hidden={{ id: String(r.id) }}
                        label="지우기"
                        pendingLabel="지우는 중…"
                      />
                    </div>
                  </article>
                ))
              )}
            </section>
          )}

          {/* ── 품목 단위 목록 ─────────────────────────────── */}
          {view !== 'risk' && view !== 'conflict' && view !== 'link' && (
            <section className="mt-6">
              <form method="get" className="mb-4 flex flex-wrap gap-2">
                <input type="hidden" name="view" value={view} />
                <input
                  type="text" name="q" defaultValue={data.q} placeholder="품목이나 검색어"
                  className="border border-rule bg-surface px-3 py-1.5 text-[13px]"
                />
                <button type="submit" className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft">
                  찾기
                </button>
              </form>

              {data.groups.length === 0 ? (
                <EmptyState message="해당하는 품목이 없습니다." />
              ) : (
                data.groups.map((g) => (
                  <article key={`${g.item_group}-${g.target}`} className="border-t border-rule py-3.5">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-[14px] font-semibold">{g.target}</span>
                      <span className="text-[11px] text-ink-3">{g.item_group}</span>
                      {g.used_by > 0 && (
                        <span className="text-[11px] text-measure">실제 품목명 {g.used_by}건에 걸림</span>
                      )}
                      <span className="ml-auto text-[11px] text-ink-3">
                        담당자 {g.expert} · AI 확정 {g.llm_approved} · AI 대기 {g.llm_pending}
                        {g.rejected > 0 && ` · 반려 ${g.rejected}`}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {g.keywords.map((k) => <KeywordChip key={k.id} k={k} />)}
                    </div>

                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {g.llm_pending > 0 && (
                        <>
                          <ActionForm
                            action={reviewTarget}
                            hidden={{ itemGroup: g.item_group, target: g.target, toStatus: 'approved' }}
                            label={`AI 제안 ${g.llm_pending}개 모두 확정`}
                            pendingLabel="확정하는 중…"
                          />
                          <ActionForm
                            action={reviewTarget}
                            hidden={{ itemGroup: g.item_group, target: g.target, toStatus: 'rejected' }}
                            label="모두 반려"
                            pendingLabel="반려하는 중…"
                          />
                        </>
                      )}
                      <ActionForm
                        action={suggestForTarget}
                        hidden={{ itemGroup: g.item_group, subItem: g.target }}
                        label="AI로 검색어 더 만들기"
                        pendingLabel="만드는 중…"
                      />
                    </div>
                  </article>
                ))
              )}

              <div className="mt-5 flex gap-3 text-[12px]">
                {data.page > 1 && (
                  <a href={`/keywords?view=${view}&q=${encodeURIComponent(data.q)}&page=${data.page - 1}`}
                     className="border border-rule px-3 py-1.5 hover:bg-rule-soft">이전</a>
                )}
                {data.groups.length === PAGE && (
                  <a href={`/keywords?view=${view}&q=${encodeURIComponent(data.q)}&page=${data.page + 1}`}
                     className="border border-rule px-3 py-1.5 hover:bg-rule-soft">다음</a>
                )}
              </div>
            </section>
          )}

          {/* ── 직접 넣기 ─────────────────────────────────── */}
          <section className="mt-10 border border-rule px-4 py-4">
            <div className="label">검색어 직접 넣기</div>
            <p className="mt-1.5 text-[12px] text-ink-3">
              담당자가 넣은 것은 바로 확정 상태가 됩니다.
            </p>
            <form action={addKeyword as unknown as string} className="mt-3 flex flex-wrap gap-2">
              <select name="itemGroup" className="border border-rule bg-surface px-2 py-1.5 text-[13px]">
                <option value="전기용품">전기용품</option>
                <option value="생활용품">생활용품</option>
                <option value="어린이제품">어린이제품</option>
              </select>
              <input name="subItem" placeholder="법정 품목명" required
                     className="border border-rule bg-surface px-3 py-1.5 text-[13px]" />
              <input name="keyword" placeholder="검색어(일상 용어)" required
                     className="border border-rule bg-surface px-3 py-1.5 text-[13px]" />
              <button type="submit" className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft">
                넣기
              </button>
            </form>
          </section>

          {/* ── 내보내기 · 가져오기 ────────────────────────── */}
          <section className="mt-6 border border-rule px-4 py-4">
            <div className="label">엑셀로 주고받기</div>
            <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-ink-3">
              내려받아 엑셀에서 고친 뒤 다시 올리면 됩니다. 올리기 전에 무엇이 바뀌는지 먼저
              보여 드립니다 — 사전이 조용히 바뀌면 분석 결과도 조용히 바뀌기 때문입니다.
              파일에 없는 줄은 건드리지 않습니다.
            </p>
            <div className="mt-3 flex flex-wrap items-start gap-3">
              <a href="/api/keywords/export"
                 className="inline-block border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft">
                CSV 내려받기
              </a>
              <KeywordImport />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
