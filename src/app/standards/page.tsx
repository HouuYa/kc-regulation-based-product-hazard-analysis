import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState, Row, TermsNote } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { PageToc, type TocItem } from '@/components/PageToc';

export const dynamic = 'force-dynamic';

const STANDARDS_TOC: TocItem[] = [
  { id: 'standards-status', label: '준비 상태' },
  { id: 'standards-list', label: '안전기준 목록' },
];

/**
 * 안전기준 적재 현황
 *
 * 담당자가 여기서 알아야 하는 것은 "이 기준으로 분석해도 되는가"다.
 * 조항 수만으로는 알 수 없고, 위해요인 코드와 시험방법 연결이 함께 있어야 한다.
 * 시험방법 연결이 없으면 관련 조항을 찾아도 어떤 시험을 의뢰할지 잇지 못한다.
 *
 * 이름을 보여 주는 순서 (담당자 요청: "KC 60335-1라고만 쓰지 말고 명칭도")
 *   title_ko    문서 안에서 뽑은 한글 표제 — 전기용품 계열 40건
 *   item_name   파일명 괄호에서 뽑은 품목명 — 부속서 계열
 *   둘 다 없으면 번호만 나온다. 없는 이름을 지어내지는 않는다.
 */

interface StandardRow {
  id: number;
  display_name: string;
  title_ko: string | null;
  cert_scheme: string | null;
  item_name: string | null;
  total_pages: number | null;
  clauses: number;
  tagged: number;
  embedded: number;
  test_links: number;
  unresolved: number;
  conditions: number;
}

interface Summary {
  standards: number;
  clauses: number;
  tagged: number;
  /** 코드를 붙일 수 있는 조항 수 — 요건 조항이면서 본문이 있는 것 */
  taggable: number;
  embedded: number;
  embeddable: number;
  testLinks: number;
  conditions: number;
  unresolved: number;
}

/** 표 머리글과 각 줄이 같은 칸 배분을 쓴다. 한 곳에서 정의해 어긋나지 않게 한다 */
const GRID = 'grid grid-cols-[1fr_repeat(5,minmax(52px,auto))] gap-3';

export default async function StandardsPage() {
  let rows: StandardRow[] = [];
  let summary: Summary | null = null;
  let error: string | null = null;

  try {
    const db = getDb();

    [summary] = await db<Summary[]>`
      select
        (select count(*)::int from public.standard where is_current)                          as standards,
        (select count(*)::int from public.clause)                                             as clauses,
        (select count(distinct clause_id)::int from public.clause_tag)                        as tagged,
        -- 코드를 붙이는 대상은 "요건" 조항뿐이다(v0.7 §5.3). 정의·적용범위·시험방법에
        -- 코드를 붙이면 아무것도 요구하지 않는 문장이 진짜 요건과 같은 자격으로
        -- 검색에 걸린다. 본문이 거의 없는 조각도 제외한다.
        (select count(*)::int from public.clause c2
          join public.standard s2 on s2.id = c2.standard_id
          where s2.is_current and c2.clause_role = 'REQUIREMENT'
            and length(btrim(c2.body)) >= 15)                                                as taggable,
        (select count(*)::int from public.clause where embedding is not null)                 as embedded,
        (select count(*)::int from public.clause
          where search_text is not null and length(btrim(search_text)) > 0)                   as embeddable,
        (select count(*)::int from public.clause_link
          where link_type = 'TEST_METHOD' and to_clause_id is not null)                       as "testLinks",
        (select count(*)::int from public.test_condition)                                     as conditions,
        (select count(*)::int from public.clause_link where to_clause_id is null)             as unresolved
    `;

    rows = await db<StandardRow[]>`
      select
        s.id, s.display_name, s.title_ko, s.cert_scheme, s.item_name, s.total_pages,
        count(c.id)::int as clauses,
        count(*) filter (where exists (
          select 1 from public.clause_tag t where t.clause_id = c.id))::int as tagged,
        count(*) filter (where c.embedding is not null)::int as embedded,
        (select count(*)::int from public.clause_link l
          join public.clause fc on fc.id = l.from_clause_id
          where fc.standard_id = s.id and l.link_type = 'TEST_METHOD'
            and l.to_clause_id is not null) as test_links,
        (select count(*)::int from public.clause_link l
          join public.clause fc on fc.id = l.from_clause_id
          where fc.standard_id = s.id and l.to_clause_id is null) as unresolved,
        (select count(*)::int from public.test_condition tc
          join public.clause cc on cc.id = tc.clause_id
          where cc.standard_id = s.id) as conditions
      from public.standard s
      left join public.clause c on c.standard_id = s.id
      where s.is_current
      group by s.id
      order by count(c.id) desc
    `;
  } catch (e) {
    console.error('안전기준 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_10rem]">
      <div>
      <PageHead
        label="1 · 안전기준"
        title="들여온 기준과 준비 상태"
        lead="조항 수만 봐서는 분석할 수 있는지 알 수 없습니다. 위해요인 코드가 있어야 코드로 찾을 수 있고, 시험방법이 이어져 있어야 찾아낸 조항에서 실제 시험까지 갈 수 있습니다."
      />

      {error && <ConnectionError error={error} />}

      {summary && (
        <div id="standards-status" className="scroll-mt-8">
        <StatusBar
          items={[
            { label: '기준 문서', value: summary.standards, note: '지금 쓰고 있는 안전기준' },
            { label: '조항', value: summary.clauses, note: '검색이 걸리는 가장 작은 덩어리입니다. 조항 하나가 한 덩어리' },
            {
              label: '위해요인 코드', value: summary.tagged, of: summary.taggable,
              note: `오른쪽 수는 코드를 붙이는 요건 조항만 센 것입니다. 정의·적용범위·시험방법 ${(summary.clauses - summary.taggable).toLocaleString()}건에는 코드를 붙이지 않습니다`,
            },
            {
              label: '의미 검색 준비', value: summary.embedded, of: summary.embeddable,
              note: '뜻으로 찾으려면 검색용 문장이 먼저 있어야 합니다. 오른쪽 수는 그 문장이 있는 조항입니다',
            },
            {
              label: '시험방법 연결', value: summary.testLinks,
              note: '이 요건을 어느 시험으로 확인하는지 조항끼리 이어 둔 것',
            },
            {
              label: '시험 항목·허용치', value: summary.conditions,
              note: '기준 표에서 뽑아낸 수치. 예: 납 90 mg/kg 이하',
            },
            {
              label: '다른 기준 참조', value: summary.unresolved,
              note: '가리키는 조항이 다른 기준에 있습니다. KC 60335 계열이 제1부를 가리키는 경우입니다',
            },
          ]}
        />
        </div>
      )}

      {!error && rows.length === 0 && (
        <EmptyState
          message="아직 들여온 기준이 없습니다."
          commands={[
            { cmd: 'npm run standards:inspect', note: '넣기 전에 읽어들인 결과를 먼저 봅니다' },
            { cmd: 'npm run standards:load -- --only "부속서 8"', note: '기준 하나만 넣습니다' },
            { cmd: 'npm run standards:load', note: 'KC안전기준/ 폴더에 있는 것을 모두 넣습니다' },
          ]}
        />
      )}

      {rows.length > 0 && (
        <section id="standards-list" className="mt-10 scroll-mt-8">
          {/*
            머리글을 고정한다 (담당자 요청).
            76건을 아래로 훑다 보면 어느 숫자가 무슨 칸인지 잊는다. 화면 위에 붙여 둔다.
          */}
          <div className={`label sticky top-0 z-10 border-b border-rule bg-paper pt-2 pb-2 ${GRID}`}>
            <span>기준</span>
            <span className="text-right">조항</span>
            <span className="text-right">코드</span>
            <span className="text-right">의미검색</span>
            <span className="text-right">시험연결</span>
            <span className="text-right">허용치</span>
          </div>

          {rows.map((r) => {
            const notReady = r.tagged === 0 || r.test_links === 0;
            const name = r.title_ko ?? r.item_name;
            return (
              <Row key={r.id}>
                <div className={`items-baseline ${GRID}`}>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">
                      <span className="addr">{r.display_name}</span>
                      {name && <span className="ml-2 font-normal text-ink-2">{name}</span>}
                    </div>
                    <div className="text-[11px] text-ink-3">
                      {r.cert_scheme}
                      {r.total_pages && ` · ${r.total_pages}쪽`}
                      {r.unresolved > 0 && (
                        <span className="text-caution"> · 다른 기준 참조 {r.unresolved}</span>
                      )}
                    </div>
                  </div>
                  <span className="addr tnum text-right text-[13px]">{r.clauses}</span>
                  <span className={`addr tnum text-right text-[13px] ${r.tagged ? '' : 'text-caution'}`}>
                    {r.tagged}
                  </span>
                  <span className={`addr tnum text-right text-[13px] ${r.embedded ? '' : 'text-ink-3'}`}>
                    {r.embedded}
                  </span>
                  <span className={`addr tnum text-right text-[13px] ${r.test_links ? '' : 'text-caution'}`}>
                    {r.test_links}
                  </span>
                  <span className="addr tnum text-right text-[13px] text-ink-2">{r.conditions}</span>
                </div>
                {notReady && (
                  <div className="mt-1.5 text-[11px] leading-snug text-caution">
                    {r.tagged === 0 &&
                      '위해요인 코드가 없어 코드로 찾는 방식이 작동하지 않습니다. 뜻이 비슷한 문장을 찾는 방식만 남습니다. '}
                    {r.test_links === 0 &&
                      '시험방법 연결이 없습니다. 관련 조항은 찾을 수 있지만 어떤 시험을 의뢰해야 하는지까지는 알려 드리지 못합니다.'}
                  </div>
                )}
              </Row>
            );
          })}
        </section>
      )}

      <TermsNote />
      </div>
      <PageToc items={STANDARDS_TOC} />
      </div>
    </div>
  );
}
