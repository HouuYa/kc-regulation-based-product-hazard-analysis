import Link from 'next/link';
import { getDb } from '@/lib/db';
import { classifiedSql } from '@/lib/cases/classified';
import { ConnectionError, PageHead, TermsNote } from '@/components/Panel';

export const dynamic = 'force-dynamic';

/**
 * 홈 — 역할별 입구 (05_02 P3-7, 2026-10-07)
 *
 * 전에는 "분석을 시작할 수 있는 상태인가"를 묻는 지표 12개가 이 화면의 전부였다.
 * 그 질문을 갖는 사람은 관리자뿐이고, 지표 8개는 안전기준 화면과 겹쳤다. 사고조사·
 * 리콜·KC기준 담당자와 정책담당자는 첫 화면에서 할 일을 찾을 수 없었다.
 *
 * 이제 첫 질문은 "당신은 누구이고, 지금 무엇을 하면 되나"다. 카드마다 그 사람의
 * 할 일 숫자 한두 개와 들어갈 화면을 단다. 준비 상태 지표는 관리 콘솔(진척 현황)로 옮겼다.
 *
 * 숫자의 분모를 함께 적는다 — "0건"이 "할 일 없음"인지 "아직 시작 안 함"인지 갈리게
 * 하는 것이 이 체계의 원칙이다(v0.7 §7.8).
 */

interface Counts {
  accidents: number;
  accUnconfirmed: number;
  accPendingCases: number;
  recalls: number;
  recUnscoped: number;
  recUnchecked: number;
  clausesUnreviewed: number;
  linksUnreviewed: number;
  policyCases: number;
  reviews: number;
  parked: number;
  cronFailed24h: number;
}

async function loadCounts(): Promise<Counts> {
  const [row] = await getDb()<Counts[]>`
    select
      (select count(*)::int from public.case_event where source_type = 'ACCIDENT') as accidents,
      (select count(*)::int from public.case_event
        where source_type = 'ACCIDENT' and not is_confirmed)                       as "accUnconfirmed",
      -- 분석했는데 판정하지 않은 후보가 남은 사고 (analysis/[caseId]/page.tsx 의 「다음 사건」과 같은 정의)
      (select count(distinct r.case_id)::int from public.match_run r
        join public.case_event e on e.id = r.case_id
        join public.match_result mr on mr.run_id = r.id
        where e.source_type = 'ACCIDENT'
          and not exists (select 1 from public.review_log rl where rl.match_result_id = mr.id)) as "accPendingCases",
      (select count(*)::int from public.case_event
        where source_type in ('RECALL_OVERSEAS', 'RECALL_DOMESTIC'))               as recalls,
      -- 품목이 정말 비어 있는 리콜만 — 정의는 lib/cases/classified.ts 한 곳(2026-10-07)
      (select count(*)::int from public.case_event e
        where e.source_type in ('RECALL_OVERSEAS', 'RECALL_DOMESTIC')
          and not ${classifiedSql('e')})                                           as "recUnscoped",
      (select count(*)::int from public.recall_cache
        where coalesce(domestic_check, 'UNCHECKED') = 'UNCHECKED')                 as "recUnchecked",
      (select count(distinct clause_id)::int from public.clause_tag
        where review_status = 'auto_unreviewed')                                   as "clausesUnreviewed",
      (select count(*)::int from public.taxonomy_standard
        where review_status = 'auto_unreviewed')                                   as "linksUnreviewed",
      (select count(distinct case_id)::int from public.second_opinion_finding
        where output_kind = 'POLICY_SIGNAL')                                       as "policyCases",
      (select count(*)::int from public.review_log)                                as reviews,
      (select parked from public.ops_status)                                       as parked,
      (select cron_failed_24h from public.ops_status)                              as "cronFailed24h"
  `;
  return row;
}

function Card({
  who, does, href, cta, items,
}: {
  who: string;
  does: string;
  href: string;
  cta: string;
  items: Array<{ label: string; value: string; href?: string; warn?: boolean }>;
}) {
  return (
    <section className="flex flex-col border border-rule bg-surface px-5 py-4">
      <div className="label">{who}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{does}</p>
      <ul className="mt-3 space-y-1.5">
        {items.map((i) => (
          <li key={i.label} className="flex items-baseline justify-between gap-3 border-t border-rule-soft pt-1.5 text-[12px]">
            {i.href ? (
              <Link href={i.href} className="text-ink-2 underline decoration-rule underline-offset-2 hover:text-measure">{i.label}</Link>
            ) : (
              <span className="text-ink-2">{i.label}</span>
            )}
            <span className={`addr tnum ${i.warn ? 'text-caution' : 'text-ink'}`}>{i.value}</span>
          </li>
        ))}
      </ul>
      <Link
        href={href}
        className="mt-4 self-start border border-measure px-3 py-1.5 text-[12px] font-medium text-measure hover:bg-measure-soft"
      >
        {cta} →
      </Link>
    </section>
  );
}

const n = (v: number) => v.toLocaleString();

export default async function HomePage() {
  let c: Counts | null = null;
  let error: string | null = null;
  try {
    c = await loadCounts();
  } catch (e) {
    // 화면에는 원인을 뿌리지 않으므로(ConnectionError) 서버 기록에는 반드시 남긴다
    console.error('홈 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  const adminOk = c != null && c.parked === 0 && c.cronFailed24h === 0;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="KC안전기준 제품위해 분석"
        title="맡은 일을 고르세요"
        lead="사고·리콜이 들어오면 관련될 수 있는 안전기준 조항을 찾아 드립니다. 위반 여부를 판정하지 않습니다 — 확인과 판단은 담당자가 합니다."
      />

      {error && <ConnectionError error={error} />}

      {c && (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card
            who="사고조사 담당자"
            does="사고보고서 원문을 확인하고, 관련될 수 있는 조항을 채택·반려합니다."
            href="/accidents"
            cta="사고조사"
            items={[
              { label: '원문 확인 대기', value: `${n(c.accUnconfirmed)} / ${n(c.accidents)}`, warn: c.accUnconfirmed > 0 },
              { label: '판정이 남은 사고', value: `${n(c.accPendingCases)}건`, warn: c.accPendingCases > 0 },
            ]}
          />
          <Card
            who="리콜정보 분석자"
            does="1단계로 국내와 관계있는지 가리고, 2단계로 관련 조항을 찾습니다."
            href="/recalls"
            cta="리콜 분석"
            items={[
              { label: '품목 미분류 (자동 판정·원본 분류 모두 없음)', value: `${n(c.recUnscoped)} / ${n(c.recalls)}`, href: '/recalls?scope=unset', warn: c.recUnscoped > 0 },
              { label: '국내 유통 미확인', value: `${n(c.recUnchecked)} / ${n(c.recalls)}`, href: '/recalls?check=UNCHECKED', warn: c.recUnchecked > 0 },
            ]}
          />
          <Card
            who="KC안전기준 담당자"
            does="조항에 붙은 위해요인 코드와 품목→기준 대응을 확정합니다."
            href="/standards/review"
            cta="코드 검수"
            items={[
              { label: '코드 검수 대기 조항', value: `${n(c.clausesUnreviewed)}건`, href: '/standards/review', warn: c.clausesUnreviewed > 0 },
              { label: '품목→기준 대응 검수 대기', value: `${n(c.linksUnreviewed)}건`, href: '/dictionary?tab=link', warn: c.linksUnreviewed > 0 },
            ]}
          />
          <Card
            who="정책담당자"
            does="위해 분포와 불량·불법 비중, 기준 사각지대 후보를 봅니다. 숫자마다 어디까지 확인된 것인지 함께 적습니다."
            href="/policy"
            cta="정책 현황판"
            items={[
              { label: '사각지대 신호가 나온 사고', value: `${n(c.policyCases)}건` },
              { label: '담당자 검토 기록', value: `${n(c.reviews)}건`, warn: c.reviews === 0 },
            ]}
          />
          <Card
            who="시스템 관리운영자"
            does="자동 작업·알림·AI 비용과 자료 준비 진척을 봅니다."
            href="/admin"
            cta="관리 콘솔"
            items={[
              {
                label: '시스템 상태',
                value: adminOk ? '이상 없음' : `확인 필요 (보류 ${c.parked} · 실패 ${c.cronFailed24h})`,
                warn: !adminOk,
              },
            ]}
          />
        </div>
      )}

      <TermsNote />
    </div>
  );
}
