import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { ActionForm } from '@/components/ActionForm';
import { BoardPager, BoardTabs, parseBoard, type BoardParams } from '@/components/Board';
import { GROUP_ORDER, standardName } from '@/lib/standards/label';
import { loadCodebookSnapshot, codeLabelMap } from '@/lib/codebook/snapshot';
import { reviewClause } from './actions';
import { CLAUSE_REJECT_REASONS } from './reject-options';

export const dynamic = 'force-dynamic';

/**
 * 조항 위해요인 코드 검수
 *
 * 왜 이 화면이 필요한가
 *   AI 가 붙인 코드는 기본이 '자동(미검수)'다. 설계문서는 검수를 거친 코드만
 *   정식 근거로 쓰겠다고 했는데, 정작 확정할 화면이 없어서 조항 태그 1,855건이
 *   100% 미검수로 남아 있었다. 그래서 근거등급 A 가 한 번도 나오지 않았고,
 *   "검수 확정분만 검색에 쓰기" 스위치도 켤 수가 없었다.
 *
 *   여기서 누른 한 번이 세 곳에서 살아난다 —
 *   근거등급 A, 검색 스위치, 그리고 기준 개선 분석의 재료가 되는 판단 기록.
 *
 * 화면이 지켜야 할 것
 *   1. 조항 본문을 먼저 보여 준다. 코드만 보고는 판단할 수 없다.
 *   2. 근거 문구를 함께 보여 주되, 그것이 조항 전체에 대한 것임을 밝힌다.
 *      지금 구조는 조항 하나의 근거를 그 조항의 모든 코드가 함께 쓴다.
 *      코드별 근거로 오해하면 잘못된 확정이 나온다.
 *   3. 어떤 코드북 판·태깅 판으로 붙은 코드인지 적는다. 판이 바뀌면 같은 판단이
 *      더 이상 유효하지 않을 수 있다.
 *   4. 확정을 기본으로 두지 않는다. 아무것도 안 누르면 미검수로 남는다 —
 *      "다음"만 계속 눌러서 전부 확정되는 화면은 검수가 아니라 통과 의식이다.
 */

const PER = 10;

interface TagRow {
  code: string;
  axis: 'HF' | 'DT';
  is_primary: boolean;
  confidence_score: string | null;
  agreement_score: string | null;
}

interface ClauseRow {
  id: number;
  marker: string;
  part: string | null;
  breadcrumb_path: string | null;
  body: string;
  standard_name: string | null;
  /** 담당자는 자기 품목군만 맡는다 — 번호만으로는 남의 것인지 내 것인지도 모른다 */
  item_group: string;
  item_name: string | null;
  title_ko: string | null;
  /** 원인 코드가 「원인 미확인」뿐인가. 그렇다면 검수해도 얻을 것이 적다 */
  only_unknown: boolean;
  evidence_span: string | null;
  codebook_version: string;
  tagging_version: string;
  review_status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  tags: TagRow[];
}

/** 화면이 실제로 그리는 모양 — 코드 이름을 붙인 뒤 */
type TagWithLabel = TagRow & { label: string | null };

interface Summary {
  unreviewed: number;
  approved: number;
  rejected: number;
  clausesUnreviewed: number;
  reviewedToday: number;
}

async function load(params: BoardParams) {
  const db = getDb();
  const { page, offset } = { ...parseBoard(params, 'id'), offset: 0 };
  const per = PER;
  const skip = (page - 1) * per;
  void offset;
  const group = params.group ?? '';
  const only = params.only ?? 'meaningful';

  /*
    줄 세우는 순서와 거르기 (2026-09-09, 배포 화면을 직접 열어 보고)

    검수 화면을 실제로 열어 보니 첫 화면에 나온 것이 문서 표지의 영문 문구
    ("Household and similar electrical appliances – Safety Part 2-13 …")였다.
    `order by standard_id, order_index` 라 문서 순서대로 나오고, 그 앞머리는
    거의 언제나 표지·머리말이다. 검수자가 처음 보는 열 건이 판단할 거리가 없는
    것들이면 그 화면은 다시 열리지 않는다.

    두 가지를 고친다.
      1. 담당자는 자기 품목군만 맡는다. 대분류로 거를 수 있어야 한다.
         (전기용품 3,394 · 어린이제품 1,773 · 생활용품 1,225)
      2. 원인 코드가 「HF.UNKNOWN 원인 미확인」뿐인 조항이 6,400 중 절반이 넘는다.
         그것을 확정해 봐야 분석에 보태는 것이 없다. 기본은 「판단할 거리가 있는 것」만
         보이고, 나머지는 따로 골라 볼 수 있게 둔다 — 감추지는 않는다.
  */
  const meaningful = db`exists (
    select 1 from public.clause_tag ct
    where ct.clause_id = c.id and ct.axis = 'HF' and ct.code <> 'HF.UNKNOWN')`;

  const where = db`
    where s.is_current
      and exists (
        select 1 from public.clause_tag ct
        where ct.clause_id = c.id and ct.review_status = 'auto_unreviewed')
      ${group ? db`and s.item_group = ${group}` : db``}
      ${only === 'meaningful' ? db`and ${meaningful}` : db``}
      ${only === 'unknown' ? db`and not ${meaningful}` : db``}
  `;

  // 검수 상태별 태그 수 — 담당자가 "얼마나 남았는가"를 먼저 본다
  const summaryQuery = db<Summary[]>`
    select
      (select count(*)::int from public.clause_tag where review_status = 'auto_unreviewed') as unreviewed,
      (select count(*)::int from public.clause_tag where review_status = 'approved')        as approved,
      (select count(*)::int from public.clause_tag where review_status = 'rejected')        as rejected,
      (select count(distinct clause_id)::int from public.clause_tag
        where review_status = 'auto_unreviewed')                                            as "clausesUnreviewed",
      (select count(*)::int from public.clause_tag_review
        where created_at > now() - interval '24 hours')                                     as "reviewedToday"
  `;

  /*
    미검수 태그가 있는 조항을 조항 단위로 모은다.

    조항마다 코드가 여러 개이므로 태그를 json 으로 접어서 한 행으로 만든다.
    행별로 다시 조회하면 25행에 25번을 더 왕복한다.
  */
  const rowsQuery = db<ClauseRow[]>`
    select
      c.id, c.marker, c.part, c.breadcrumb_path, c.body,
      s.display_name as standard_name,
      s.item_group, s.item_name, s.title_ko,
      not exists (select 1 from public.clause_tag ct
                  where ct.clause_id = c.id and ct.axis = 'HF'
                    and ct.code <> 'HF.UNKNOWN') as only_unknown,
      t.evidence_span, t.codebook_version, t.tagging_version,
      t.review_status, t.reviewed_by, t.reviewed_at::text,
      -- 코드 이름은 여기서 조인하지 않는다. 코드북 표는 판(version_id)별로 행이
      -- 있어서 판을 안 걸면 같은 코드가 여러 번 나온다. 이름 붙이는 일은 이미
      -- codebook/snapshot.ts 가 하고 있으므로 그것을 쓴다(CLAUDE.md §9)
      (select json_agg(json_build_object(
                'code', t2.code, 'axis', t2.axis, 'is_primary', t2.is_primary,
                'confidence_score', t2.confidence_score,
                'agreement_score', t2.agreement_score)
              order by t2.axis, t2.is_primary desc, t2.code)
       from public.clause_tag t2
       where t2.clause_id = c.id) as tags
    from public.clause c
    join public.standard_view s on s.id = c.standard_id
    -- 조항의 대표 태그 하나에서 판번호·근거·상태를 읽는다. 같은 조항의 태그는
    -- 같은 실행에서 붙으므로 이 값들이 서로 다르지 않다
    join lateral (
      select ct.evidence_span, ct.codebook_version, ct.tagging_version,
             ct.review_status, ct.reviewed_by, ct.reviewed_at
      from public.clause_tag ct where ct.clause_id = c.id
      order by ct.id limit 1
    ) t on true
    ${where}
    -- 본문이 짧은 조각(표지·머리말·「제1부를 적용한다」류)은 판단할 거리가 적다.
    -- 지우지는 않고 뒤로 민다.
    order by (length(btrim(c.body)) < 40), c.standard_id, c.order_index
    limit ${per} offset ${skip}
  `;

  // 쪽 넘김은 「지금 걸러 본 것」의 수를 따라야 한다. 전체 수를 쓰면 빈 쪽이 생긴다
  const filteredQuery = db<{ n: number }[]>`
    select count(*)::int as n
    from public.clause c
    join public.standard_view s on s.id = c.standard_id
    ${where}
  `;

  const groupQuery = db<{ item_group: string; n: number }[]>`
    select s.item_group, count(distinct c.id)::int as n
    from public.clause c
    join public.standard_view s on s.id = c.standard_id
    where s.is_current
      and exists (select 1 from public.clause_tag ct
                  where ct.clause_id = c.id and ct.review_status = 'auto_unreviewed')
      and exists (select 1 from public.clause_tag ct
                  where ct.clause_id = c.id and ct.axis = 'HF' and ct.code <> 'HF.UNKNOWN')
    group by s.item_group
  `;

  const [[summary], rows, [filtered], groups, snapshot] = await Promise.all([
    summaryQuery, rowsQuery, filteredQuery, groupQuery,
    loadCodebookSnapshot({ includeUncommon: true }),
  ]);
  const labels = codeLabelMap(snapshot);
  const groupCount = new Map<string, number>();
  for (const g of groups) groupCount.set(g.item_group, g.n);

  return {
    summary,
    rows: rows.map((r) => ({
      ...r,
      tags: (r.tags ?? []).map((t) => ({ ...t, label: labels.get(t.code) ?? null })),
    })),
    page, per, groupCount, only, filteredTotal: filtered.n,
  };
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

export default async function ReviewPage({
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
    console.error('조항 검수 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  const total = data ? data.summary.unreviewed + data.summary.approved + data.summary.rejected : 0;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="1 · 안전기준"
        title="조항 위해요인 코드 검수"
        lead="AI가 붙인 코드를 사람이 확인합니다. 확정한 코드만 정식 근거로 쓰입니다."
        workflow={[
          { label: '기준 확인', href: '/standards', state: 'done' },
          { label: '코드 부여', note: 'AI가 붙임', state: 'done' },
          { label: '코드 검수', who: '사람', note: '이 화면', state: 'here' },
          { label: '분석에 사용', href: '/accidents', note: '근거등급 A', state: 'todo' },
        ]}
      />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          <div className="mt-8">
            <StatusBar
              items={[
                { label: '검수 대기', value: data.summary.unreviewed, wantsZero: true },
                { label: '확정', value: data.summary.approved },
                { label: '반려', value: data.summary.rejected },
                { label: '오늘 검수', value: data.summary.reviewedToday },
              ]}
            />
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-ink-2">
            전체 코드 {total.toLocaleString()}건 중 {pct(data.summary.approved, total)}가 확정됐습니다.
            검수를 기다리는 조항은{' '}
            <span className="addr tnum text-ink">
              {data.summary.clausesUnreviewed.toLocaleString()}개
            </span>
            이고, 아래 조건으로 걸러 본 것은{' '}
            <span className="addr tnum text-ink">{data.filteredTotal.toLocaleString()}개</span>
            입니다.
          </p>

          {/*
            왜 확정이 중요한지 한 번은 적어 둔다. 이 화면을 처음 여는 담당자는
            "이걸 왜 해야 하는가"를 모른 채 버튼만 보게 된다.
          */}
          <div className="mt-4 border border-rule-soft px-4 py-3 text-[12px] leading-relaxed text-ink-2">
            확정한 코드는 분석 결과에서 <span className="text-measure">근거등급 A</span>로 제시됩니다.
            미검수 코드는 등급 B에 머물고, 「검수 확정분만 사용」 설정을 켜면 검색에서 아예 빠집니다.
            반려한 코드는 지금도 검색에 쓰이지 않습니다.
          </div>

          {/*
            자기 품목군만 보게 한다 (담당자 지적, 2026-09-09)
            "안전기준 담당자는 품목별로 나뉘어 있어 자기 품목군이 아니면 다른 품목에
             대해선 일반인보다도 잘 모른다." 남의 품목을 검수하게 두면 안 된다.
          */}
          <BoardTabs
            basePath="/standards/review"
            params={params}
            name="group"
            options={[
              { value: '', label: '전체' },
              ...GROUP_ORDER.filter((g) => (data.groupCount.get(g) ?? 0) > 0).map((g) => ({
                value: g,
                label: `${g} ${(data.groupCount.get(g) ?? 0).toLocaleString()}`,
              })),
            ]}
          />

          <BoardTabs
            basePath="/standards/review"
            params={params}
            name="only"
            options={[
              { value: 'meaningful', label: '판단할 거리가 있는 것' },
              { value: 'unknown', label: '원인 미확인뿐인 것' },
              { value: 'all', label: '전부' },
            ]}
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            원인 코드가 <span className="addr">HF.UNKNOWN</span>(원인 미확인)뿐인 조항은
            확정해도 분석에 보태는 것이 없어 기본 목록에서 뺐습니다. 미검수 조항 6,400개 중
            절반이 넘습니다. 감춘 것이 아니라 뒤로 미룬 것이니, 가운데 단추로 따로 볼 수 있습니다.
          </p>

          {data.rows.length === 0 ? (
            <div className="mt-8">
              <EmptyState message="이 조건에 맞는 조항이 없습니다. 위 단추로 조건을 넓혀 보세요." />
            </div>
          ) : (
            <section className="mt-8">
              {data.rows.map((c) => (
                <article key={c.id} className="border-t border-rule py-5">
                  {/* 번호 옆에 대분류와 품목명 — 자기 품목이 아니면 번호는 아무 뜻도 아니다 */}
                  <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-ink-3">
                    <span className="border border-rule px-1 text-[10px]">{c.item_group}</span>
                    <span className="text-ink-2">
                      {standardName({
                        display_name: c.standard_name ?? '',
                        item_name: c.item_name,
                        title_ko: c.title_ko,
                      }).name ?? '명칭 미상'}
                    </span>
                    <span className="addr">
                      {c.standard_name ?? '기준 미상'}
                      {c.part && ` · ${c.part}`}
                      {c.breadcrumb_path && ` · ${c.breadcrumb_path}`}
                    </span>
                    {c.only_unknown && (
                      <span className="text-caution">원인 미확인뿐 — 확정해도 분석에 쓰이지 않습니다</span>
                    )}
                  </div>
                  <div className="mt-1 text-[14px] font-semibold">{c.marker}</div>

                  <p className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
                    {c.body.length > 900 ? `${c.body.slice(0, 900)}…` : c.body}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(c.tags ?? []).map((t: TagWithLabel) => (
                      <span
                        key={`${t.axis}-${t.code}`}
                        className={`addr border px-2 py-1 text-[11px] ${
                          t.is_primary
                            ? 'border-measure text-measure bg-measure-soft'
                            : 'border-rule text-ink-2'
                        }`}
                        title={`${t.axis} · 신뢰도 ${t.confidence_score ?? '—'} · 반복 일치도 ${t.agreement_score ?? '—'}`}
                      >
                        {t.code}
                        {t.label && <span className="ml-1.5 font-sans">{t.label}</span>}
                        {t.is_primary && <span className="ml-1.5 font-sans">· 주</span>}
                      </span>
                    ))}
                  </div>

                  {c.evidence_span && (
                    <div className="mt-3 border-l-2 border-rule bg-surface px-3 py-2">
                      <div className="label">근거로 삼은 구절</div>
                      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{c.evidence_span}</p>
                      {/*
                        지금 구조는 조항 하나의 근거를 모든 코드가 함께 쓴다(tag-run.ts).
                        코드별 근거로 오해하면 잘못된 확정이 나오므로 반드시 밝힌다.
                      */}
                      <p className="mt-1.5 text-[11px] text-ink-3">
                        이 구절은 조항 전체에 대한 근거입니다. 코드마다 따로 뽑은 것이 아닙니다.
                      </p>
                    </div>
                  )}

                  <div className="addr mt-3 text-[11px] text-ink-3">
                    코드북 {c.codebook_version} · 태깅 {c.tagging_version}
                  </div>

                  <div className="mt-3 flex flex-wrap items-start gap-2">
                    <ActionForm
                      action={reviewClause}
                      hidden={{ clauseId: c.id, toStatus: 'approved' }}
                      label="확정"
                      pendingLabel="확정하는 중…"
                      className="border border-measure bg-measure px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
                    />
                    <form action={reviewClause as unknown as (fd: FormData) => void} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="clauseId" value={c.id} />
                      <input type="hidden" name="toStatus" value="rejected" />
                      <select
                        name="rejectReason"
                        required
                        aria-label="반려 사유"
                        defaultValue=""
                        className="border border-rule bg-surface px-2 py-2 text-[12px]"
                      >
                        <option value="" disabled>
                          반려 사유 선택
                        </option>
                        {CLAUSE_REJECT_REASONS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft"
                      >
                        반려
                      </button>
                    </form>
                  </div>
                </article>
              ))}

              <div className="mt-6">
                <BoardPager
                  basePath="/standards/review"
                  params={params}
                  page={data.page}
                  per={data.per}
                  total={data.filteredTotal}
                />
              </div>
            </section>
          )}

          <p className="mt-8 text-[12px] text-ink-3">
            <Link href="/standards" className="underline decoration-rule underline-offset-2 hover:text-measure">
              안전기준 목록으로 돌아가기
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
