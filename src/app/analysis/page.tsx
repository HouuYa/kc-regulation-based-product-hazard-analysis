import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState, Row } from '@/components/Panel';

export const dynamic = 'force-dynamic';

/** 분석 대상 사건 목록. 확정된 것만 분석에 들어간다(§8.1) */
interface CaseRow {
  id: number;
  title: string | null;
  narrative: string;
  item_name: string | null;
  source_type: string;
  is_confirmed: boolean;
  tag_count: number;
  run_count: number;
  last_results: number | null;
  adopted: number;
}

export default async function AnalysisListPage() {
  let rows: CaseRow[] = [];
  let error: string | null = null;

  try {
    rows = await getDb()<CaseRow[]>`
      select
        e.id, e.title, e.narrative, e.item_name, e.source_type, e.is_confirmed,
        (select count(*)::int from public.case_tag t where t.case_id = e.id) as tag_count,
        (select count(*)::int from public.match_run r where r.case_id = e.id) as run_count,
        (select r.result_count from public.match_run r
          where r.case_id = e.id order by r.started_at desc limit 1) as last_results,
        (select count(*)::int from public.review_log rl
          join public.match_result mr on mr.id = rl.match_result_id
          join public.match_run mrun on mrun.id = mr.run_id
          where mrun.case_id = e.id and rl.decision = 'ADOPTED') as adopted
      from public.case_event e
      order by e.created_at desc
    `;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="4 · 분석"
        title="사건별 시험 후보군"
        lead="사건에 붙은 위해요인 코드로 관련될 수 있는 조항을 찾고, 그 조항이 지목하는 시험방법까지 잇습니다. 채택·반려 기록이 정확도 측정의 재료가 됩니다."
      />

      {error && <ConnectionError error={error} />}

      {!error && rows.length === 0 && (
        <EmptyState
          message="분석할 사건이 없습니다."
          commands={[{ cmd: '/cases', note: '사고보고서를 먼저 등록하세요' }]}
        />
      )}

      {rows.length > 0 && (
        <section className="mt-9">
          {rows.map((r) => (
            <Row key={r.id} href={`/analysis/${r.id}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-[13px] font-medium">
                  {r.title ?? r.narrative.slice(0, 50)}
                </span>
                <span className="addr tnum text-[11px] text-ink-3">
                  {r.run_count > 0 ? `후보 ${r.last_results ?? 0}` : '미분석'}
                  {r.adopted > 0 && ` · 채택 ${r.adopted}`}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-ink-3">
                {r.source_type === 'ACCIDENT' ? '사고보고서' : '리콜'}
                {r.item_name && ` · ${r.item_name}`}
                {!r.is_confirmed && <span className="text-caution"> · 미확정</span>}
                {r.tag_count === 0 && <span className="text-caution"> · 코드화 안 됨</span>}
              </div>
            </Row>
          ))}
        </section>
      )}
    </div>
  );
}
