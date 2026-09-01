import Link from 'next/link';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * 개요 — "지금 어디까지 준비됐는가"
 *
 * 이 화면이 답해야 하는 질문은 하나다. 분석을 돌릴 수 있는 상태인가?
 * 설계문서가 매칭 전에 확인하라고 한 것들(v0.7 §7.1 3단계 "데이터 완전성 확인")을
 * 담당자가 매번 SQL 로 세지 않아도 되게 한다.
 *
 * 태깅되지 않은 조항이 있으면 검색 결과 0건이 "기준에 없다"가 아니라
 * "아직 준비가 안 됐다"는 뜻이 된다. 그 구분을 못 하면 데이터 누락을
 * 정책 신호로 오인한다(v0.7 §7.8). 그래서 이 숫자들을 첫 화면에 둔다.
 */

interface Status {
  standards: number;
  clauses: number;
  clausesTagged: number;
  clausesEmbedded: number;
  testConditions: number;
  testMethodLinks: number;
  unresolvedLinks: number;
  codebookVersion: string | null;
  codebookCodes: number;
  cases: number;
  runs: number;
  reviews: number;
}

async function loadStatus(): Promise<{ status: Status | null; error: string | null }> {
  try {
    const db = getDb();
    const [row] = await db<Status[]>`
      select
        (select count(*)::int from public.standard where is_current)             as standards,
        (select count(*)::int from public.clause)                                as clauses,
        (select count(distinct clause_id)::int from public.clause_tag)           as "clausesTagged",
        (select count(*)::int from public.clause where embedding is not null)    as "clausesEmbedded",
        (select count(*)::int from public.test_condition)                        as "testConditions",
        (select count(*)::int from public.clause_link
          where link_type = 'TEST_METHOD' and to_clause_id is not null)          as "testMethodLinks",
        (select count(*)::int from public.clause_link where to_clause_id is null) as "unresolvedLinks",
        (select version from codebook.version where status = 'active')            as "codebookVersion",
        (select count(*)::int from codebook.hazard_factor hf
          join codebook.version v on v.id = hf.version_id and v.status = 'active') as "codebookCodes",
        (select count(*)::int from public.case_event)                             as cases,
        (select count(*)::int from public.match_run)                              as runs,
        (select count(*)::int from public.review_log)                             as reviews
    `;
    return { status: row, error: null };
  } catch (e) {
    return { status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function Metric({
  label, value, of, note, href,
}: {
  label: string; value: number; of?: number; note?: string; href?: string;
}) {
  const ready = of == null ? value > 0 : of > 0 && value >= of;
  const body = (
    <div className="border-t border-rule pt-3">
      <div className="label">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={`addr tnum text-[26px] leading-none font-medium ${ready ? 'text-ink' : 'text-ink-3'}`}>
          {value.toLocaleString()}
        </span>
        {of != null && (
          <span className="addr tnum text-[13px] text-ink-3">/ {of.toLocaleString()}</span>
        )}
      </div>
      {note && <div className="mt-1.5 text-[11px] leading-snug text-ink-3">{note}</div>}
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-70">{body}</Link> : body;
}

export default async function OverviewPage() {
  const { status, error } = await loadStatus();

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
      <header>
        <div className="label">개요</div>
        <h1 className="mt-2 text-[28px] leading-tight font-semibold tracking-tight">
          분석을 돌릴 수 있는 상태인가
        </h1>
        <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-ink-2">
          조항이 태깅되지 않았거나 시험방법 연결이 없으면, 검색 결과 0건은
          <span className="text-ink"> 기준에 조항이 없다</span>는 뜻이 아니라
          <span className="text-ink"> 아직 준비가 안 됐다</span>는 뜻입니다. 먼저 여기를 봅니다.
        </p>
      </header>

      {error && (
        <section className="mt-8 border border-halt bg-halt-soft px-5 py-4">
          <div className="text-[13px] font-semibold text-halt">데이터베이스에 연결하지 못했습니다</div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
            <code className="addr">.env.local</code> 의 <code className="addr">DATABASE_URL</code> 을 채우세요.
            Supabase 대시보드의 <span className="text-ink">Connect → Session pooler</span> 연결 문자열입니다.
          </p>
          <pre className="addr mt-3 overflow-x-auto border border-rule bg-surface px-3 py-2 text-[11px] text-ink-2">
            {error}
          </pre>
        </section>
      )}

      {status && (
        <>
          <section className="mt-10 grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-4">
            <Metric
              label="안전기준" value={status.standards} href="/standards"
              note="적재된 기준 문서"
            />
            <Metric
              label="조항" value={status.clauses} href="/standards"
              note="검색 단위. 조항 하나가 한 조각"
            />
            <Metric
              label="태깅된 조항" value={status.clausesTagged} of={status.clauses}
              note="HF/DT 코드가 붙은 조항. 코드 갈래는 여기까지만 찾습니다"
            />
            <Metric
              label="임베딩" value={status.clausesEmbedded} of={status.clauses}
              note="의미 갈래 대상. 검색용 텍스트가 바뀌면 다시 만듭니다"
            />
            <Metric
              label="시험방법 연결" value={status.testMethodLinks}
              note="성능요건 → 시험방법. 이것이 없으면 후보가 나와도 시험을 못 잇습니다"
            />
            <Metric
              label="시험조건" value={status.testConditions}
              note="항목·허용치·단위"
            />
            <Metric
              label="미해결 참조" value={status.unresolvedLinks}
              note="대상이 다른 기준에 있는 참조. KC 60335 계열이 제1부를 가리킵니다"
            />
            <Metric
              label="위해요인 코드" value={status.codebookCodes}
              note={status.codebookVersion ? `코드북 ${status.codebookVersion}` : '적재되지 않음'}
              href="/codebook"
            />
          </section>

          <section className="mt-12 grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-4">
            <Metric label="사건" value={status.cases} href="/cases" note="사고보고서·리콜" />
            <Metric label="분석 실행" value={status.runs} note="재실행 시 새 기록을 쌓습니다" />
            <Metric
              label="담당자 판단" value={status.reviews}
              note="채택·반려 기록. 재현율·오탐률이 여기서 계산됩니다"
            />
          </section>

          {status.clauses === 0 && (
            <section className="mt-12 border-t border-rule pt-6">
              <div className="label">다음 할 일</div>
              <ol className="mt-3 space-y-2 text-[13px] text-ink-2">
                <li>
                  <code className="addr text-ink">npm run codebook:load -- --activate</code>
                  <span className="ml-2 text-ink-3">위해요인 코드북을 적재합니다</span>
                </li>
                <li>
                  <code className="addr text-ink">npm run standards:load -- --only &quot;부속서 8&quot;</code>
                  <span className="ml-2 text-ink-3">안전기준 조항을 적재합니다</span>
                </li>
                <li>
                  <code className="addr text-ink">npm run tag -- --standard &quot;부속서 8&quot;</code>
                  <span className="ml-2 text-ink-3">조항에 HF/DT 코드를 붙입니다</span>
                </li>
                <li>
                  <code className="addr text-ink">npm run embed</code>
                  <span className="ml-2 text-ink-3">의미 검색용 벡터를 만듭니다</span>
                </li>
              </ol>
            </section>
          )}
        </>
      )}
    </div>
  );
}
