import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState, Row } from '@/components/Panel';

export const dynamic = 'force-dynamic';

/**
 * 안전기준 적재 현황
 *
 * 담당자가 여기서 알아야 하는 것은 "이 기준으로 분석해도 되는가"다.
 * 조항 수만으로는 알 수 없고, 태깅과 시험방법 연결이 함께 있어야 한다.
 * 시험방법 연결이 없으면 후보를 찾아도 어떤 시험을 의뢰할지 잇지 못한다.
 */

interface StandardRow {
  id: number;
  display_name: string;
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

export default async function StandardsPage() {
  let rows: StandardRow[] = [];
  let error: string | null = null;

  try {
    rows = await getDb()<StandardRow[]>`
      select
        s.id, s.display_name, s.cert_scheme, s.item_name, s.total_pages,
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
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="1 · 안전기준"
        title="적재된 기준과 그 준비 상태"
        lead="조항 수만으로는 분석할 수 있는지 알 수 없습니다. 태깅이 있어야 코드 갈래가 작동하고, 시험방법 연결이 있어야 후보에서 시험으로 이어집니다."
      />

      {error && <ConnectionError error={error} />}

      {!error && rows.length === 0 && (
        <EmptyState
          message="적재된 기준이 없습니다."
          commands={[
            { cmd: 'npm run standards:inspect', note: '적재 전에 파싱 결과를 먼저 봅니다' },
            { cmd: 'npm run standards:load -- --only "부속서 8"', note: '한 기준만 적재합니다' },
            { cmd: 'npm run standards:load', note: 'KC안전기준/ 전체를 적재합니다' },
          ]}
        />
      )}

      {rows.length > 0 && (
        <section className="mt-9">
          <div className="label grid grid-cols-[1fr_repeat(5,minmax(52px,auto))] gap-3 pb-2">
            <span>기준</span>
            <span className="text-right">조항</span>
            <span className="text-right">태깅</span>
            <span className="text-right">임베딩</span>
            <span className="text-right">시험연결</span>
            <span className="text-right">시험조건</span>
          </div>

          {rows.map((r) => {
            const notReady = r.tagged === 0 || r.test_links === 0;
            return (
              <Row key={r.id}>
                <div className="grid grid-cols-[1fr_repeat(5,minmax(52px,auto))] items-baseline gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">{r.display_name}</div>
                    <div className="text-[11px] text-ink-3">
                      {r.cert_scheme}
                      {r.item_name && ` · ${r.item_name}`}
                      {r.total_pages && ` · ${r.total_pages}쪽`}
                      {r.unresolved > 0 && (
                        <span className="text-caution"> · 미해결 참조 {r.unresolved}</span>
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
                  <div className="mt-1.5 text-[11px] text-caution">
                    {r.tagged === 0 && '태깅되지 않아 코드 갈래가 작동하지 않습니다. '}
                    {r.test_links === 0 && '시험방법 연결이 없어 후보에서 시험으로 잇지 못합니다.'}
                  </div>
                )}
              </Row>
            );
          })}
        </section>
      )}
    </div>
  );
}
