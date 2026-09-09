import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { ActionForm } from '@/components/ActionForm';
import { BoardToolbar, BoardTabs, BoardPager, parseBoard, type BoardParams } from '@/components/Board';
import { GROUP_ORDER, asGroup, standardName } from '@/lib/standards/label';
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
 * 검수 화면으로 다시 짰다 (담당자 지적, 2026-09-09)
 *   "검수용 페이지가 아니라 그냥 정보제공 수준으로 페이지가 구성되어 있다.
 *    초보 담당자가 검수를 위해 참고할 수단이 제공되지 않는 경우가 많다."
 *
 *   맞는 지적이었다. 예전 화면은 「(비대상)종아리마사지기 → KC 60335-2-32」라고만
 *   적어 두었다. 이것을 확정할지 반려할지 판단하려면 적어도 셋이 필요하다.
 *     1. 이 이상한 이름이 어디서 왔는가        → 원본 사고보고서·리콜로 가는 길
 *     2. AI 가 왜 그 기준을 골랐는가            → 그때 남긴 근거 문장
 *     3. 그 기준이 대체 무슨 기준인가           → 번호 옆의 품목명
 *   셋 다 이미 데이터베이스에 있었는데 화면이 보여 주지 않았다.
 *
 *   특히 3번은 화면 전체에 걸린 문제다 — 안전기준 담당자는 품목별로 나뉘어 있어
 *   자기 품목군 밖은 일반인보다도 모른다. 「KC 60335-2-32」만 보고는 검수할 수 없다.
 *
 * 왜 내보내기·가져오기가 있는가
 *   담당자는 실제로 엑셀로 일한다 — 이 프로젝트의 정답지도 엑셀로 받았다.
 *   한 건씩 화면에서 고치는 것보다 내려받아 한꺼번에 손보고 되돌려 넣는 쪽이
 *   훨씬 빠르다. 그 길이 없으면 이 사전은 결국 안 쓰이게 된다.
 */

interface StandardBrief {
  id: number;
  display_name: string;
  item_name: string | null;
  title_ko: string | null;
  items: string[] | null;
  sub_items: string[] | null;
  item_group: string;
}

interface TermRow {
  term_key: string;
  term: string;
  standard_count: number;
  standards: StandardBrief[];
  has_expert: boolean;
  unreviewed_count: number;
  item_group: string | null;
  /** AI 가 이 대응을 고른 이유. 검수의 핵심 재료다 */
  evidence: string | null;
  source: string | null;
  confidence: number | null;
  brick_code: string | null;
  /** 배정을 돌렸는가, 어느 계위까지 좁혔는가 (061) */
  gpc_level: string | null;
  gpc_checked: string | null;
  gpc_evidence: string | null;
  brick_title_ko: string | null;
  brick_title_en: string | null;
  class_title: string | null;
  family_title: string | null;
  segment_title: string | null;
}

interface SourceCase {
  term_key: string;
  id: number;
  title: string | null;
  item_name: string | null;
  source_type: string;
}

async function load(params: BoardParams) {
  const db = getDb();
  const { q, page, per } = parseBoard(params, 'term');
  const skip = (page - 1) * per;
  const only = params.status ?? '';
  const group = params.group ?? '';

  /*
    대분류는 이어진 안전기준에서 가져온다 (058)

    용어 자체에는 대분류가 없다. 「LED등기구」가 전기용품인 것은 그것이 이어진
    기준이 전기용품이기 때문이다. 여러 기준에 걸리면 최빈값을 쓴다.
  */
  const where = db`
    where t.review_status <> 'rejected' and s.is_current
      ${q ? db`and (t.term ilike ${'%' + q + '%'} or s.display_name ilike ${'%' + q + '%'}
                    or s.item_name ilike ${'%' + q + '%'})` : db``}
  `;

  const having = db`
    having 1 = 1
      ${only === 'unreviewed' ? db`and count(*) filter (where t.review_status = 'auto_unreviewed') > 0` : db``}
      ${only === 'expert' ? db`and bool_or(t.source = 'EXPERT')` : db``}
      ${only === 'no_gpc' ? db`and max(g.brick_code) is null and max(g.checked_at) is not null` : db``}
      ${only === 'gpc_todo' ? db`and max(g.checked_at) is null and max(g.brick_code) is null` : db``}
      ${group ? db`and mode() within group (order by s.item_group) = ${group}` : db``}
  `;

  const [[summary], [{ total }], rows, stds] = await Promise.all([
    db<{ terms: number; unreviewed: number; expert: number; withGpc: number; gpcTried: number }[]>`
      select
        (select count(*)::int from public.scope_term_view)                              as terms,
        (select count(*)::int from public.scope_term_view where unreviewed_count > 0)   as unreviewed,
        (select count(*)::int from public.scope_term_view where has_expert)             as expert,
        (select count(*)::int from public.scope_term_view where brick_code is not null) as "withGpc",
        (select count(distinct v.term_key)::int from public.scope_term_view v
          join public.scope_term_gpc g on g.term_key = v.term_key
          where g.brick_code is null and g.checked_at is not null)                 as "gpcTried"
    `,
    db<{ total: number }[]>`
      select count(*)::int as total from (
        select t.term_key
        from public.scope_term t
        join public.standard_view s on s.id = t.standard_id
        left join public.scope_term_gpc g on g.term_key = t.term_key
        ${where}
        group by t.term_key
        ${having}
      ) x
    `,
    db<TermRow[]>`
      select t.term_key,
             min(t.term) as term,
             count(*)::int as standard_count,
             jsonb_agg(jsonb_build_object(
               'id', s.id, 'display_name', s.display_name, 'item_name', s.item_name,
               'title_ko', s.title_ko, 'items', s.items, 'sub_items', s.sub_items,
               'item_group', s.item_group
             ) order by s.display_name) as standards,
             bool_or(t.source = 'EXPERT') as has_expert,
             count(*) filter (where t.review_status = 'auto_unreviewed')::int as unreviewed_count,
             mode() within group (order by s.item_group) as item_group,
             (array_agg(t.evidence order by t.confidence desc nulls last))[1] as evidence,
             (array_agg(t.source   order by t.confidence desc nulls last))[1] as source,
             max(t.confidence)::float as confidence,
             max(g.brick_code) as brick_code,
             max(g.verified_level) as gpc_level,
             max(g.checked_at)::text as gpc_checked,
             max(g.evidence) as gpc_evidence,
             max(gb.brick_title_ko)  as brick_title_ko,
             max(gb.brick_title_en)  as brick_title_en,
             max(coalesce(gb.class_title_ko,   gb.class_title_en))   as class_title,
             max(coalesce(gb.family_title_ko,  gb.family_title_en))  as family_title,
             max(coalesce(gb.segment_title_ko, gb.segment_title_en)) as segment_title
      from public.scope_term t
      join public.standard_view s on s.id = t.standard_id
      left join public.scope_term_gpc g on g.term_key = t.term_key
      left join public.gpc_brick gb on gb.brick_code = g.brick_code
      ${where}
      group by t.term_key
      ${having}
      order by min(t.term)
      limit ${per} offset ${skip}
    `,
    db<{ display_name: string }[]>`
      select display_name from public.standard where is_current order by display_name
    `,
  ]);

  /*
    이 용어가 어느 사고보고서·리콜에서 나왔는가

    「(비대상)종아리마사지기」·「Balbali 전기 주전자」·「L1LCRCA」 같은 이름이
    사전에 있는 것을 담당자가 이상하게 여겼다. 이상한 게 맞다 — 원본 서류의
    제품명이 그대로 올라온 것이다(파일명 「(25)9 (비대상)종아리마사지기
    사고조사 보고서」). 그런데 화면이 출처를 안 보여 주니 오류처럼 보인다.
    원본으로 가는 길을 놓으면 담당자가 1분 만에 판단할 수 있다.
  */
  /*
    브릭이 붙었으면 「그래서 국내에서 무엇인가」까지 보여 준다 (K-GPC, 2026-09-09)

    담당자가 알고 싶은 것은 「10002225」가 아니라 「이건 어린이제품이고 안전확인
    대상인가」다. 표준 제품분류체계는 브릭에 속성(사용 연령·재질)을 더해 그것을
    정하는 체계이고, 그 대응표를 우리가 이미 갖고 있다(product_taxonomy).
    갈래가 여럿이면 좁히지 않고 모두 보여 준다 — 좁히는 것은 사람의 일이다.
  */
  interface DomesticRow {
    brick_code: string; item_group: string; cert_scheme: string; item: string;
  }
  const bricks = [...new Set(rows.map((r) => r.brick_code).filter((b): b is string => !!b))];
  const domesticRows: DomesticRow[] = bricks.length === 0 ? [] : await db<DomesticRow[]>`
    select distinct brick_code, item_group, cert_scheme, item
    from public.product_taxonomy
    where brick_code = any(${bricks}::text[])
      and nullif(btrim(item_group), '') is not null
      and nullif(btrim(cert_scheme), '') is not null
    order by brick_code, item_group, cert_scheme, item
  `;
  const domesticByBrick = new Map<string, DomesticRow[]>();
  for (const d of domesticRows) {
    const list = domesticByBrick.get(d.brick_code) ?? [];
    list.push(d);
    domesticByBrick.set(d.brick_code, list);
  }

  const keys = rows.map((r) => r.term_key);
  const cases = keys.length === 0 ? [] : await db<SourceCase[]>`
    select public.scope_term_key(item_name) as term_key, id, title, item_name, source_type
    from public.case_event
    where public.scope_term_key(item_name) = any(${keys}::text[])
    order by id desc
  `;
  const caseByTerm = new Map<string, SourceCase[]>();
  for (const c of cases) {
    const list = caseByTerm.get(c.term_key) ?? [];
    if (list.length < 4) list.push(c);
    caseByTerm.set(c.term_key, list);
  }

  return {
    summary, rows, total, page, per,
    standards: stds.map((s) => s.display_name),
    caseByTerm, domesticByBrick,
  };
}

const SOURCE_NOTE: Record<string, string> = {
  EXPERT: '담당자가 엑셀로 넣은 대응입니다.',
  SEMANTIC: 'AI가 기준의 적용범위 문장과 견줘 고른 대응입니다.',
  LLM: 'AI가 고른 대응입니다.',
};

/** GPC 계위 — 위에서 아래로 세그먼트 › 패밀리 › 클래스 › 브릭 */
const GPC_LEVEL_LABEL: Record<string, string> = {
  BRICK: '브릭(가장 아래)',
  CLASS: '클래스',
  FAMILY: '패밀리',
  SEGMENT: '세그먼트(가장 위)',
  NONE: '맞는 것이 없다는 판단',
};

const CASE_LABEL: Record<string, string> = {
  ACCIDENT: '사고보고서',
  RECALL_DOMESTIC: '국내 리콜',
  RECALL_OVERSEAS: '해외 리콜',
};

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
        lead="사고보고서와 리콜 서류에 적힌 제품 이름을, 어느 안전기준으로 볼 것인지 이어 둔 표입니다. 분석은 여기서 정해진 기준만 뒤집니다."
        workflow={data ? [
          { label: '서류의 제품명', href: '/accidents', note: '사고·리콜에서', state: 'done' },
          { label: '사전에 등록', note: `${data.summary.terms.toLocaleString()}종`, state: 'done' },
          { label: '기준 이어 붙이기', note: 'AI가 적용범위와 견줌', state: 'done' },
          {
            label: '담당자 검수',
            who: '사람',
            note: data.summary.unreviewed > 0 ? `대기 ${data.summary.unreviewed.toLocaleString()}` : '끝',
            state: data.summary.unreviewed > 0 ? 'here' : 'done',
          },
          { label: '분석 범위로 사용', href: '/analysis', note: '이 기준만 뒤진다', state: 'todo' },
        ] : undefined}
      />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          <StatusBar
            items={[
              { label: '등록된 품목', value: data.summary.terms },
              { label: '담당자 확정', value: data.summary.expert, of: data.summary.terms },
              { label: '검수 대기', value: data.summary.unreviewed, wantsZero: true },
              { label: 'GPC 연결', value: data.summary.withGpc, of: data.summary.terms,
                note: data.summary.gpcTried > 0
                  ? `${data.summary.gpcTried}종은 배정을 돌렸지만 브릭까지 좁히지 못했습니다 — GPC에 없는 것이 아니라 후보가 갈린 것입니다`
                  : undefined },
            ]}
          />

          {/* ── 이 화면을 처음 보는 사람에게 ─────────────────── */}
          <details className="mt-6 border border-rule-soft">
            <summary className="cursor-pointer px-4 py-2.5 text-[12px] text-ink-2">
              이 표가 무엇인지 — <span className="text-ink">품목명</span>은 어디서 온 이름이고,{' '}
              <span className="text-ink">적용기준</span>과 <span className="text-ink">GPC</span>는
              무엇이 다른지
            </summary>
            <div className="border-t border-rule-soft px-4 py-3.5 text-[12px] leading-relaxed text-ink-2">
              <p>
                <span className="text-ink">품목명</span>은 사고조사보고서나 리콜 공표문에 적힌
                제품 이름을 그대로 가져온 것입니다. 담당자가 엑셀로 넣은 이름도 함께 있습니다.
                원본 서류의 표기를 고치지 않고 그대로 두기 때문에, 브랜드명이 붙어 있거나
                (Balbali 전기 주전자) 모델 기호만 있거나(L1LCRCA) 「(비대상)」 같은 표시가
                섞인 이름이 보입니다. 각 줄의 <span className="text-ink">원본 보기</span>로
                어느 서류에서 온 이름인지 확인할 수 있습니다.
              </p>
              <p className="mt-2.5">
                <span className="text-ink">적용기준</span>은 그 제품을 어느 KC안전기준으로 볼
                것인지입니다. 분석은 여기서 정해진 기준의 조항만 뒤집니다. 그래서 이것이 틀리면
                다른 제품의 시험항목이 근거로 제시됩니다.
              </p>
              <p className="mt-2.5">
                <span className="text-ink">GPC</span>는 국제 상품분류(GS1)입니다. 우리 사고는
                한국어로, 해외 리콜은 영어로 적히기 때문에, 「같은 종류의 제품」으로 묶어 세려면
                언어와 무관한 번호가 하나 필요합니다. 그 용도로만 씁니다.
              </p>
              <p className="mt-2.5">
                <span className="text-ink">GPC로는 기준을 고르지 않습니다.</span> 담당자가 만든
                엑셀을 세어 보니, 한 GPC 코드가 여러 품목을 묶는 4건 중 3건에서 적용기준이
                서로 달랐습니다. 예를 들어 GPC 10000759「개인용 온열·마사지용품」 하나에
                눈마사지기 · 손목마사지기 · 전기찜질기가 함께 묶이는데, 이 셋의 KC안전기준은
                제각각입니다. GPC는 「가게에서 어느 매대에 놓느냐」의 분류이고 KC안전기준은
                「무엇이 위험하냐」의 분류라, 애초에 나누는 축이 다릅니다.
              </p>
            </div>
          </details>

          {/* ── 목록 ─────────────────────────────────────────── */}
          <h2 className="mt-10 border-b-2 border-ink pb-2 text-[15px] font-semibold">
            품목 목록
          </h2>

          {/*
            대분류 토글 (담당자 요청, 2026-09-09)
            "LED등기구 등 리스트가 많아서 가독성을 높이는 조치가 필요하다."
            담당자는 대개 한 대분류만 맡으므로, 먼저 자기 것만 남기고 보게 한다.
          */}
          <BoardTabs
            basePath="/terms"
            params={params}
            name="group"
            options={[
              { value: '', label: '전체' },
              ...GROUP_ORDER.map((g) => ({ value: g, label: g })),
            ]}
          />

          <BoardToolbar
            basePath="/terms"
            params={params}
            placeholder="품목명 또는 기준(번호·품목명)으로 찾기"
            filters={[{
              name: 'status', label: '거르기',
              options: [
                { value: '', label: '전체' },
                { value: 'unreviewed', label: '검수 대기만' },
                { value: 'expert', label: '담당자 확정만' },
                { value: 'no_gpc', label: 'GPC 못 좁힌 것만' },
                { value: 'gpc_todo', label: 'GPC 아직 안 돌린 것만' },
              ],
            }]}
          />

          {data.rows.length === 0 ? (
            <EmptyState message="조건에 맞는 품목이 없습니다." />
          ) : (
            <section className="mt-6">
              {data.rows.map((r) => {
                const sources = data.caseByTerm.get(r.term_key) ?? [];
                const group = r.item_group ? asGroup(r.item_group) : null;
                return (
                  <article key={r.term_key} className="border-t border-rule py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[14px] font-semibold">{r.term}</span>
                        {group && (
                          <span className="border border-rule px-1.5 py-0.5 text-[10px] text-ink-3">
                            {group}
                          </span>
                        )}
                      </div>
                      <span className="text-[11px]">
                        {r.unreviewed_count > 0
                          ? <span className="text-caution">검수 대기 {r.unreviewed_count}건</span>
                          : r.has_expert
                            ? <span className="text-measure">담당자 확정</span>
                            : <span className="text-ink-3">확정됨</span>}
                      </span>
                    </div>

                    {/*
                      적용기준은 번호만으로는 검수할 수 없다 — 품목명을 함께 적는다.
                      「KC 60598-2-1」이 아니라 「고정형 등기구 (KC 60598-2-1)」.
                    */}
                    <div className="mt-2 text-[12px] leading-relaxed">
                      <span className="text-ink-3">적용기준 {r.standard_count}종 </span>
                      {r.standards.map((s, i) => {
                        const { name } = standardName(s);
                        return (
                          <span key={s.id}>
                            {i > 0 && <span className="text-ink-3"> · </span>}
                            <span className="text-ink-2">{name ?? '명칭 미상'}</span>{' '}
                            <span className="addr text-[11px] text-ink-3">{s.display_name}</span>
                          </span>
                        );
                      })}
                    </div>

                    {/* 판단 재료 1 — 이 이름이 어느 서류에서 왔는가 */}
                    <div className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
                      {sources.length > 0 ? (
                        <>
                          <span>원본 보기 </span>
                          {sources.map((c, i) => (
                            <span key={c.id}>
                              {i > 0 && ' · '}
                              <Link
                                href={`/analysis/${c.id}`}
                                className="underline decoration-rule underline-offset-2 hover:text-measure"
                              >
                                {CASE_LABEL[c.source_type] ?? c.source_type} #{c.id}
                              </Link>
                            </span>
                          ))}
                        </>
                      ) : (
                        <span>
                          원본 서류가 없습니다 — 담당자가 엑셀이나 화면에서 직접 넣은 품목입니다.
                        </span>
                      )}
                    </div>

                    {/* 판단 재료 2 — 왜 이 기준을 골랐는가 */}
                    {r.evidence && (
                      <details className="mt-2 border border-rule-soft">
                        <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-ink-3">
                          이 기준을 고른 이유 보기
                          {r.source && <span> — {SOURCE_NOTE[r.source] ?? r.source}</span>}
                          {r.confidence != null && (
                            <span className="addr tnum"> 확신 {r.confidence.toFixed(2)}</span>
                          )}
                        </summary>
                        <p className="border-t border-rule-soft px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
                          {r.evidence}
                        </p>
                      </details>
                    )}

                    {/* 판단 재료 3 — GPC 는 어느 계위까지 붙었는가 */}
                    <div className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
                      {r.brick_code ? (
                        <>
                          <span>GPC </span>
                          <span className="addr">{r.brick_code}</span>{' '}
                          <span className="text-ink-2">
                            {r.brick_title_ko ?? r.brick_title_en}
                          </span>
                          <span> (브릭 — GPC의 가장 아래 계위)</span>
                          {(r.segment_title || r.family_title || r.class_title) && (
                            <div className="mt-0.5">
                              {[
                                r.segment_title && `세그먼트 ${r.segment_title}`,
                                r.family_title && `패밀리 ${r.family_title}`,
                                r.class_title && `클래스 ${r.class_title}`,
                              ].filter(Boolean).join(' › ')}
                            </div>
                          )}
                          {(() => {
                            const routes = data.domesticByBrick.get(r.brick_code ?? '') ?? [];
                            if (routes.length === 0) {
                              return (
                                <div className="mt-0.5">
                                  이 브릭은 담당자 품목표에 없습니다 — 안전관리 대상이 아니라는
                                  뜻이 아니라, 우리가 가진 대응표에 아직 없다는 뜻입니다.
                                </div>
                              );
                            }
                            const certs = new Set(routes.map((x) => x.cert_scheme));
                            return (
                              <div className="mt-1">
                                <span className="text-ink-3">국내에서는 </span>
                                {[...new Map(routes.map((x) =>
                                  [`${x.item_group}/${x.cert_scheme}`, x])).values()].map((x, i) => (
                                  <span key={`${x.item_group}-${x.cert_scheme}`}>
                                    {i > 0 && <span className="text-ink-3"> · </span>}
                                    <span className="text-ink-2">{x.item_group} {x.cert_scheme}</span>
                                  </span>
                                ))}
                                {certs.size > 1 && (
                                  <span className="text-caution">
                                    {' '}— 사용 연령·재질에 따라 갈립니다. 담당자가 확정해야 합니다
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                        </>
                      ) : r.gpc_checked ? (
                        /*
                          돌렸는데 브릭까지 못 좁힌 경우 (061)

                          "종아리마사지기가 GPC에 없다는 것이 이상하다"는 지적에서 시작해
                          배정을 실제로 돌렸다. 그런데 브릭까지 좁히지 못한 것도 나온다.
                          그것을 「아직 안 함」이라고 적으면 처음과 똑같은 잘못을 반복하는
                          것이다. 어디까지 좁혔는지, 왜 멈췄는지 그대로 적는다.
                        */
                        <span>
                          GPC 배정을 돌렸지만{' '}
                          <span className="text-ink-2">
                            {GPC_LEVEL_LABEL[r.gpc_level ?? 'NONE'] ?? r.gpc_level}
                          </span>
                          까지만 좁혔습니다.
                          {r.gpc_evidence && (
                            <span className="text-ink-3"> {r.gpc_evidence.slice(0, 160)}</span>
                          )}
                        </span>
                      ) : (
                        <span>
                          GPC 아직 배정 안 함 — 배정을 돌린 적이 없는 품목입니다.
                          <span className="text-ink-2"> GPC에 이 품목이 없다는 뜻이 아닙니다.</span>
                        </span>
                      )}
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
                );
              })}

              <div className="mt-6">
                <BoardPager basePath="/terms" params={params} page={data.page} per={data.per} total={data.total} />
              </div>
            </section>
          )}

          <p className="mt-6 text-[11px] leading-relaxed text-ink-3">
            반려와 삭제는 다릅니다. <span className="text-ink-2">반려</span>는 &ldquo;아니다&rdquo;라는 판단을 기록으로 남기고,{' '}
            <span className="text-ink-2">삭제</span>는 흔적을 없앱니다. 잘못 넣은 것은 지우고, 검토해서 아니라고
            판단한 것은 반려하는 것이 맞습니다.
          </p>

          {/* ── 엑셀로 한꺼번에 손보기 ───────────────────────── */}
          <h2 className="mt-12 border-b-2 border-ink pb-2 text-[15px] font-semibold">
            엑셀로 한꺼번에 손보기
          </h2>
          <section className="mt-4">
            <p className="text-[12px] leading-relaxed text-ink-2">
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

          {/* ── 품목 직접 추가 ───────────────────────────────── */}
          <h2 className="mt-12 border-b-2 border-ink pb-2 text-[15px] font-semibold">
            품목 직접 추가
          </h2>
          <section className="mt-4">
            <p className="text-[12px] leading-relaxed text-ink-2">
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

          {/* ── 외부 시스템에 제공 ───────────────────────────── */}
          <h2 className="mt-12 border-b-2 border-ink pb-2 text-[15px] font-semibold">
            외부 시스템에 제공 (API)
          </h2>
          <section className="mt-4 text-[12px] leading-relaxed text-ink-2">
            {/*
              사람이 누르는 버튼과 기계가 부르는 API 를 따로 두지 않았다 —
              검수 상태가 칸으로 함께 나가므로 받는 쪽이 확정된 것만 골라 쓸 수 있다.
            */}
            <p>
              다른 시스템(협회의 다른 프로그램 등)이 이 사전을 가져다 쓸 수 있습니다. 위
              「CSV 내려받기」 단추와 같은 주소입니다 —{' '}
              <code className="addr text-ink">GET /api/terms/export</code>.
            </p>
            <p className="mt-2">
              검수 상태(확정 · 미검수 · 반려)가 칸으로 함께 나가므로, 받는 쪽에서 확정된 것만
              골라 쓸 수 있습니다. 인증은 이 사이트 접속과 같은 계정을 씁니다. 그 계정은
              사이트 전체를 여는 열쇠이니 안전한 경로로 전달해 주세요.
            </p>
          </section>

          <p className="mt-10 text-[12px] text-ink-3">
            <Link href="/standards" className="underline decoration-rule underline-offset-2 hover:text-measure">
              안전기준 화면으로
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
