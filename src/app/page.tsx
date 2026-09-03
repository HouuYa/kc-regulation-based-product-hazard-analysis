import { getDb } from '@/lib/db';
import { ConnectionError, TermsNote } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';

export const dynamic = 'force-dynamic';

/**
 * 개요 — "지금 어디까지 준비됐는가"
 *
 * 이 화면이 답해야 하는 질문은 하나다. 분석을 돌릴 수 있는 상태인가?
 * 설계문서가 매칭 전에 확인하라고 한 것들(v0.7 §7.1 3단계 "데이터 완전성 확인")을
 * 담당자가 매번 SQL 로 세지 않아도 되게 한다.
 *
 * 코드가 붙지 않은 조항이 있으면 검색 결과 0건이 "기준에 없다"가 아니라
 * "아직 준비가 안 됐다"는 뜻이 된다. 그 구분을 못 하면 데이터 누락을
 * 정책 신호로 오인한다(v0.7 §7.8). 그래서 이 숫자들을 첫 화면에 둔다.
 *
 * 분모를 조심해서 고른다 (라운드 18·19에서 두 번 고친 자리)
 *   처음에는 "임베딩 498 / 13,501" 이었다. 96%가 밀린 것처럼 보였지만 사실은
 *   나머지가 아직 코드 부여 전이라 준비할 재료가 없는 상태였다.
 *   그다음에는 "코드 부여 498 / 13,501" 이 남았는데, 이것도 틀렸다 — 코드를 붙이는
 *   대상은 요건 조항뿐이고(v0.7 §5.3) 정의·적용범위·시험방법은 애초에 대상이 아니다.
 *   분모는 언제나 "할 수 있는 것"이어야 숫자가 사실을 말한다.
 */

interface Status {
  standards: number;
  clauses: number;
  clausesTagged: number;
  clausesTaggable: number;
  clausesEmbedded: number;
  clausesEmbeddable: number;
  testConditions: number;
  testMethodLinks: number;
  unresolvedLinks: number;
  codebookVersion: string | null;
  codebookCodes: number;
  accidents: number;
  recalls: number;
  analyzed: number;
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
        -- 코드를 붙이는 대상은 요건 조항뿐이다 (v0.7 §5.3)
        (select count(*)::int from public.clause c
          join public.standard s on s.id = c.standard_id
          where s.is_current and c.clause_role = 'REQUIREMENT'
            and length(btrim(c.body)) >= 15)                                     as "clausesTaggable",
        (select count(*)::int from public.clause where embedding is not null)    as "clausesEmbedded",
        (select count(*)::int from public.clause
          where search_text is not null and length(btrim(search_text)) > 0)      as "clausesEmbeddable",
        (select count(*)::int from public.test_condition)                        as "testConditions",
        (select count(*)::int from public.clause_link
          where link_type = 'TEST_METHOD' and to_clause_id is not null)          as "testMethodLinks",
        (select count(*)::int from public.clause_link where to_clause_id is null) as "unresolvedLinks",
        (select version from codebook.version where status = 'active')            as "codebookVersion",
        (select count(*)::int from codebook.hazard_factor hf
          join codebook.version v on v.id = hf.version_id and v.status = 'active') as "codebookCodes",
        (select count(*)::int from public.case_event where source_type = 'ACCIDENT') as accidents,
        (select count(*)::int from public.case_event
          where source_type in ('RECALL_DOMESTIC', 'RECALL_OVERSEAS'))            as recalls,
        (select count(distinct case_id)::int from public.match_run)               as analyzed,
        (select count(*)::int from public.review_log)                             as reviews
    `;
    return { status: row, error: null };
  } catch (e) {
    // 화면에는 원인을 뿌리지 않으므로(ConnectionError) 서버 기록에는 반드시 남긴다
    console.error('개요 화면 데이터 조회 실패:', e);
    return { status: null, error: e instanceof Error ? e.message : String(e) };
  }
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
          조항에 위해요인 코드가 붙지 않았거나 시험방법 연결이 없으면, 검색 결과 0건은
          <span className="text-ink"> 기준에 조항이 없다</span>는 뜻이 아니라
          <span className="text-ink"> 아직 준비가 안 됐다</span>는 뜻입니다. 먼저 여기를 봅니다.
        </p>
      </header>

      {error && <ConnectionError error={error} />}

      {status && (
        <>
          <StatusBar
            items={[
              { label: '안전기준', value: status.standards, href: '/standards', note: '적재된 기준 문서' },
              { label: '조항', value: status.clauses, href: '/standards', note: '검색의 최소 단위' },
              {
                label: '위해요인 코드', value: status.clausesTagged, of: status.clausesTaggable,
                href: '/standards',
                note: '분모는 코드를 붙이는 대상인 요건 조항입니다. 정의·적용범위·시험방법은 대상이 아닙니다',
              },
              {
                label: '의미 검색 준비', value: status.clausesEmbedded, of: status.clausesEmbeddable,
                href: '/ops',
                note: '분모는 준비할 재료(검색용 문장)가 있는 조항입니다. 새 자료는 1분 안에 자동으로 준비됩니다',
              },
              {
                label: '시험방법 연결', value: status.testMethodLinks, href: '/standards',
                note: '이 요건은 몇 조 시험으로 확인하는가. 없으면 조항을 찾아도 시험으로 잇지 못합니다',
              },
              {
                label: '시험 항목·허용치', value: status.testConditions, href: '/standards',
                note: '기준 표에서 뽑은 수치',
              },
              {
                label: '다른 기준 참조', value: status.unresolvedLinks, href: '/standards',
                note: '가리키는 대상이 이 문서 밖에 있는 참조',
              },
              {
                label: '위해요인 코드북', value: status.codebookCodes, href: '/codebook',
                note: status.codebookVersion ? `${status.codebookVersion} 판` : '적재되지 않음',
              },
            ]}
          />

          <StatusBar
            items={[
              { label: '사고보고서', value: status.accidents, href: '/accidents', note: '올려서 원문 확인까지 마친 사건' },
              { label: '리콜', value: status.recalls, href: '/recalls', note: '해외·국내 리콜' },
              {
                label: '분석한 사건', value: status.analyzed,
                note: '관련 조항을 찾아 순위를 매긴 사건',
              },
              {
                label: '담당자 판단', value: status.reviews,
                note: '채택·반려 기록. 정확도가 여기서 계산됩니다',
              },
            ]}
          />

          {status.clauses === 0 && (
            <section className="mt-12 border-t border-rule pt-6">
              <div className="label">다음 할 일</div>
              <ol className="mt-3 space-y-2 text-[13px] text-ink-2">
                <li>
                  <code className="addr text-ink">npm run codebook:load -- --activate</code>
                  <span className="ml-2 text-ink-3">위해요인 코드북을 적재합니다</span>
                </li>
                <li>
                  <code className="addr text-ink">npm run standards:load</code>
                  <span className="ml-2 text-ink-3">안전기준 조항을 적재합니다</span>
                </li>
                <li>
                  <code className="addr text-ink">npm run tag</code>
                  <span className="ml-2 text-ink-3">조항에 위해요인 코드를 붙입니다</span>
                </li>
              </ol>
            </section>
          )}

          <TermsNote />
        </>
      )}
    </div>
  );
}
