import Link from 'next/link';
import { PageHead, ConnectionError } from '@/components/Panel';
import { PageToc, type TocItem } from '@/components/PageToc';
import { loadPolicyStats, crossTable, topDt, type PolicyStats, type CodeCount } from '@/lib/policy/stats';
import { loadInsightTables, type InsightTables as InsightData } from '@/lib/policy/insights';
import { InsightTables } from './InsightTables';

export const dynamic = 'force-dynamic';

const TOC: TocItem[] = [
  { id: 'policy-coverage', label: '덮은 범위' },
  { id: 'policy-hazard', label: '위해 분포' },
  { id: 'policy-country', label: '국가별', indent: true },
  { id: 'policy-month', label: '월별 비중', indent: true },
  { id: 'policy-defect', label: '불량·불법' },
  { id: 'policy-blind', label: '사각지대 후보' },
  { id: 'review-tables', label: '검토가 쌓이면 채워지는 표' },
  { id: 'insight-gap', label: '기준 사각지대', indent: true },
  { id: 'insight-compare', label: '국내외 대조', indent: true },
  { id: 'insight-test', label: '시험항목 사용', indent: true },
];

/**
 * 정책 현황판 — 정책담당자용 내부 화면 (05 문서 §5)
 *
 * 묻는 것: 어떤 위해가, 어디서, 얼마나 나타나고, 국내 기준·제도가 그것을 덮고 있는가.
 *
 * 이 화면이 하지 않는 것
 *   결론 문장을 만들지 않는다. "늘었다·위험하다·기준이 없다"는 담당 부서와 전문가가
 *   판단한다. 화면은 숫자, 그 숫자의 분모, 왜 아직 비어 있는지까지만 말한다.
 *
 * 맨 위에 「덮은 범위」를 두는 이유
 *   아래 분포는 전부 "코드가 붙은 만큼, 확인된 만큼"의 분포다. 담당자 검토가 0건이고
 *   국내 유통 확인이 0건인 상태에서 분포만 보면 자료의 빈 곳이 위해의 모양으로 읽힌다.
 */

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');
const fmt = (n: number) => n.toLocaleString();

const ROUTE: Record<string, { label: string; note: string }> = {
  TEST: { label: '시험으로 확인', note: '안전기준 시험항목으로 확인하는 원인 — 불량 쪽' },
  LEGAL: { label: '법령으로 확인', note: '인증·표시 의무 위반으로 판정하는 원인 — 불법 쪽' },
  GAP: { label: '기준 자체 미흡', note: '국내·국제 기준이 그 위해를 다루지 못한다고 분류된 원인' },
  OTHER: { label: '관리·공정·사람', note: '원인 미확인·설계결함·품질관리처럼 시험이나 법령 한쪽으로 가르기 어려운 원인' },
};

export default async function PolicyPage() {
  let stats: PolicyStats | null = null;
  let insights: InsightData | null = null;
  let error: string | null = null;
  try {
    [stats, insights] = await Promise.all([loadPolicyStats(), loadInsightTables()]);
  } catch (e) {
    console.error('정책 현황판 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="정책담당자"
        title="정책 현황판"
        lead="해외 리콜과 사고보고서에서 어떤 위해가 어디서 나타나는지, 그 숫자가 어디까지 확인된 것인지를 함께 봅니다. 결론은 내지 않습니다."
      />

      {error && <ConnectionError error={error} />}

      {stats && insights && (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3 text-[12px] text-ink-3">
            <a
              href="/api/policy/export"
              className="border border-rule px-3 py-1.5 text-ink hover:bg-measure-soft"
            >
              이 화면의 표 내려받기 (CSV)
            </a>
            <span>파일 이름에 기준일(오늘 날짜)이 들어갑니다. 결론 문장 없이 표만 담습니다.</span>
            {stats.codebookVersion && <span>코드북 {stats.codebookVersion}</span>}
          </div>

          <Coverage stats={stats} />
          <Hazard stats={stats} />
          <DefectIllegal stats={stats} />
          <BlindSpots stats={stats} />

          {/* ── 5. 검토가 쌓이면 채워지는 표 ───────────────────────── */}
          <section id="review-tables" className="mt-14 scroll-mt-8 border-t border-rule pt-10">
            <h2 className="text-[17px] font-semibold">검토가 쌓이면 채워지는 표</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
              옛 「KC안전기준 개선 요인」 화면의 세 표입니다. 담당자 채택·반려 기록이{' '}
              <span className="addr tnum text-ink">{fmt(insights.reviews)}건</span>
              {insights.reviews === 0
                ? '이라 그 판단에 기대는 칸은 모두 비어 있습니다. 사건 분석 화면에서 조항 후보를 검토하면 숫자가 생깁니다.'
                : '입니다.'}
            </p>
            <InsightTables data={insights} />
          </section>
        </>
      )}
      <PageToc items={TOC} />
    </div>
  );
}

/* ── 1. 덮은 범위 ───────────────────────────────────────────── */

function CoverageRow({ label, n, d, note }: { label: string; n: number; d: number; note: string }) {
  return (
    <div className="border-b border-rule-soft py-2.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[13px]">{label}</span>
        <span className="addr tnum text-[13px]">
          {fmt(n)} / {fmt(d)} <span className="text-ink-3">({pct(n, d)})</span>
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">{note}</p>
    </div>
  );
}

function Coverage({ stats }: { stats: PolicyStats }) {
  const r = stats.coverage.find((c) => c.source_type === 'RECALL_OVERSEAS');
  const a = stats.coverage.find((c) => c.source_type === 'ACCIDENT');
  return (
    <section id="policy-coverage" className="mt-8 scroll-mt-8 border border-caution bg-caution-soft px-4 py-4">
      <h2 className="text-[15px] font-semibold text-caution">덮은 범위 — 아래 숫자를 읽기 전에</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
        아래 분포는 코드가 붙은 만큼, 확인된 만큼의 분포입니다. 비율이 낮은 칸은 &ldquo;없다&rdquo;가 아니라
        &ldquo;아직 확인하지 않았다&rdquo;입니다.
      </p>
      <div className="mt-3 grid gap-6 md:grid-cols-2">
        {r && (
          <div>
            <h3 className="label">해외 리콜 {fmt(r.total)}건</h3>
            <CoverageRow label="원인 코드가 붙음" n={r.hf_coded} d={r.total}
              note={`그중 대표 원인이 「원인 미확인」뿐인 것 ${fmt(r.hf_unknown)}건.`} />
            <CoverageRow label="품목 분류됨 (자동 판정·원본 DB·담당자)" n={r.classified} d={r.total}
              note={`수집 배치의 자동 품목 판정과 원본 DB 의 GPC 분류를 그대로 씁니다. 그중 담당자가 품목을 직접 정한 것 ${fmt(r.scoped)}건. 분류가 국내 적용 기준까지 이어지는지는 법정 품목→기준 대응 검수에 달려 있습니다.`} />
            <CoverageRow label="국내 유통 확인" n={stats.domestic.checked} d={stats.domestic.total}
              note="0건이면 “국내에 안 들어왔다”가 아니라 아무도 확인하지 않았다는 뜻입니다. 국내에 풀린 해외 리콜 제품 수는 아직 답할 수 없습니다." />
            <CoverageRow label="조항 후보 검색을 돌림" n={r.analyzed} d={r.total}
              note={`담당자 채택·반려 기록 ${fmt(r.reviews)}건.`} />
          </div>
        )}
        {a && (
          <div>
            <h3 className="label">사고보고서 {fmt(a.total)}건</h3>
            <CoverageRow label="원문 확인(담당자가 추출 결과를 봄)" n={a.confirmed} d={a.total}
              note="확인 전 사건은 추출 글자가 뭉개졌는지 사람이 보지 않은 상태입니다." />
            <CoverageRow label="원인이 밝혀짐(대표 원인 ≠ 원인 미확인)" n={a.hf_coded - a.hf_unknown} d={a.total}
              note="보고서가 원인을 밝히지 못한 사건은 추정으로 채우지 않습니다(CLAUDE.md §13)." />
            <CoverageRow label="조항 후보 검색을 돌림" n={a.analyzed} d={a.total}
              note={`담당자 채택·반려 기록 ${fmt(a.reviews)}건.`} />
            <CoverageRow label="병행 점검을 돌림" n={a.second_opinion} d={a.total}
              note="병행 점검 소견은 후보일 뿐이고 결론이 아닙니다." />
            <CoverageRow label="발생일이 비어 있음" n={a.no_date} d={a.total}
              note="발생일이 없어 사고가 늘고 있는지는 답할 수 없습니다. 적재할 때 발생일을 뽑아야 풀립니다." />
          </div>
        )}
      </div>
    </section>
  );
}

/* ── 2. 위해 분포 ───────────────────────────────────────────── */

function Bar({ n, max }: { n: number; max: number }) {
  return (
    <div className="h-2 w-full bg-rule-soft" aria-hidden="true">
      <div className="h-2 bg-measure" style={{ width: `${max > 0 ? (n / max) * 100 : 0}%` }} />
    </div>
  );
}

function CodeTable({ title, rows, total, showRoute }: {
  title: string; rows: CodeCount[]; total: number; showRoute?: boolean;
}) {
  const max = Math.max(0, ...rows.map((r) => r.cases));
  return (
    <div>
      <h3 className="text-[14px] font-semibold">{title}</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[30rem] text-[12px]">
          <thead className="label border-b border-rule">
            <tr>
              <th className="py-2 text-left font-normal">코드</th>
              <th className="py-2 text-right font-normal">사건</th>
              <th className="py-2 text-right font-normal">비중</th>
              <th className="w-1/4 py-2 font-normal"><span className="sr-only">막대</span></th>
              {showRoute && <th className="py-2 text-left font-normal">확인 경로</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className="border-b border-rule-soft">
                <td className="py-1.5">
                  {r.name_ko ?? '(코드북에 없음)'} <span className="addr text-ink-3">{r.code}</span>
                </td>
                <td className="addr tnum py-1.5 text-right">{fmt(r.cases)}</td>
                <td className="addr tnum py-1.5 text-right text-ink-2">{pct(r.cases, total)}</td>
                <td className="py-1.5 pl-3"><Bar n={r.cases} max={max} /></td>
                {showRoute && <td className="py-1.5 text-ink-2">{r.route ? ROUTE[r.route].label : '미지정'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Hazard({ stats }: { stats: PolicyStats }) {
  const total = stats.coverage.find((c) => c.source_type === 'RECALL_OVERSEAS')?.total ?? 0;
  const dt = stats.codes.filter((c) => c.axis === 'DT');
  const hf = stats.codes.filter((c) => c.axis === 'HF');
  const sum = (rows: CodeCount[], k: 'cases' | 'approved') => rows.reduce((a, r) => a + r[k], 0);
  const label = new Map(dt.map((c) => [c.code, c.name_ko ?? c.code]));

  const cols = topDt(stats.codes, 5);
  const country = crossTable(stats.byCountry, cols, { topRows: 10, sortBy: 'total' });
  const month = crossTable(stats.byMonth, cols, { sortBy: 'key' });
  // 나라마다 가장 많은 피해유형 — 상위 5개 열 밖에 있을 수 있어(미국의 사망) 전체에서 고른다
  const topOf = new Map<string, { code: string; cases: number }>();
  for (const r of stats.byCountry) {
    const cur = topOf.get(r.key);
    if (!cur || r.cases > cur.cases) topOf.set(r.key, { code: r.code, cases: r.cases });
  }

  return (
    <section id="policy-hazard" className="mt-12 scroll-mt-8">
      <h2 className="text-[17px] font-semibold">위해 분포 — 해외 리콜 {fmt(total)}건</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        사건마다 붙은 <span className="text-ink">대표 코드</span>로 셉니다. 대표 코드가 둘인 사건은 양쪽에 한 번씩 들어가
        합이 사건 수보다 조금 클 수 있습니다.
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
        누가 붙인 코드인가 — 대표 피해유형 {fmt(sum(dt, 'cases'))}개 중 Recall Hub 관리자 분류{' '}
        {fmt(sum(dt, 'approved'))}개 · AI 보충(검수 전) {fmt(sum(dt, 'cases') - sum(dt, 'approved'))}개,
        대표 원인 {fmt(sum(hf, 'cases'))}개 중 관리자 분류 {fmt(sum(hf, 'approved'))}개 · AI 보충(검수 전){' '}
        {fmt(sum(hf, 'cases') - sum(hf, 'approved'))}개. 관리자 분류는 리콜 원본 쪽의 판단이고, 이 체계의 담당자 검토는 아닙니다.
      </p>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <CodeTable title="대표 피해유형" rows={dt} total={total} />
        <CodeTable title="대표 원인 (상위 15)" rows={hf.slice(0, 15)} total={total} showRoute />
      </div>

      <div id="policy-country" className="mt-10 scroll-mt-8">
        <h3 className="text-[14px] font-semibold">국가별 × 대표 피해유형</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
          리콜 건수 상위 10개 국가. 열은 전체 상위 5개 피해유형이고 나머지는 「그 외」입니다. 국가 건수는 그 나라가
          리콜을 많이 낸 정도이지 위해가 많은 정도가 아닙니다.
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[46rem] text-[12px]">
            <thead className="label border-b border-rule">
              <tr>
                <th className="py-2 text-left font-normal">국가</th>
                <th className="py-2 text-right font-normal">리콜</th>
                {cols.map((c) => <th key={c} className="py-2 text-right font-normal">{label.get(c)}</th>)}
                <th className="py-2 text-right font-normal">그 외</th>
                <th className="py-2 pl-4 text-left font-normal">이 나라 최다 피해유형</th>
              </tr>
            </thead>
            <tbody>
              {country.rows.map((r) => {
                const t = topOf.get(r.key);
                return (
                  <tr key={r.key} className="border-b border-rule-soft">
                    <td className="py-1.5">{r.key}</td>
                    <td className="addr tnum py-1.5 text-right">{fmt(r.total)}</td>
                    {r.cells.map((n, i) => <td key={i} className="addr tnum py-1.5 text-right text-ink-2">{fmt(n)}</td>)}
                    <td className="addr tnum py-1.5 text-right text-ink-3">{fmt(r.other)}</td>
                    <td className="py-1.5 pl-4">
                      {t ? <>{label.get(t.code) ?? t.code} <span className="addr tnum text-ink-3">{fmt(t.cases)}</span></> : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div id="policy-month" className="mt-10 scroll-mt-8">
        <h3 className="text-[14px] font-semibold">월별 대표 피해유형 비중</h3>
        <div className="mt-2 border border-caution bg-caution-soft px-3 py-2 text-[12px] leading-relaxed text-ink-2">
          월별 <span className="text-ink">건수</span>는 위해가 아니라 <span className="text-ink">수집량</span>의 변화입니다
          (예: 1~3월 {month.rows.filter((m) => m.key <= '2026-03').map((m) => fmt(m.total)).join('·')}건,
          4~8월 {month.rows.filter((m) => m.key >= '2026-04' && m.key <= '2026-08').map((m) => fmt(m.total)).join('·')}건).
          그래서 칸에는 그달 리콜 중 그 피해유형이 차지한 <span className="text-ink">비중</span>만 적습니다.
          건수가 50건 미만인 달은 몇 건만 달라져도 비중이 크게 흔들립니다.
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[42rem] text-[12px]">
            <thead className="label border-b border-rule">
              <tr>
                <th className="py-2 text-left font-normal">월 (리콜 발생일)</th>
                <th className="py-2 text-right font-normal">분모(건)</th>
                {cols.map((c) => <th key={c} className="py-2 text-right font-normal">{label.get(c)}</th>)}
                <th className="py-2 text-right font-normal">그 외</th>
              </tr>
            </thead>
            <tbody>
              {month.rows.map((r) => (
                <tr key={r.key} className="border-b border-rule-soft">
                  <td className="py-1.5">
                    {r.key}
                    {r.total < 50 && <span className="ml-2 text-[11px] text-caution">표본 적음</span>}
                  </td>
                  <td className="addr tnum py-1.5 text-right text-ink-3">{fmt(r.total)}</td>
                  {r.cells.map((n, i) => <td key={i} className="addr tnum py-1.5 text-right">{pct(n, r.total)}</td>)}
                  <td className="addr tnum py-1.5 text-right text-ink-3">{pct(r.other, r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ── 3. 불량·불법 ───────────────────────────────────────────── */

function RouteTable({ rows }: { rows: Array<{ src: string; n: number; d: string; note: string }> }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[36rem] text-[12px]">
        <thead className="label border-b border-rule">
          <tr>
            <th className="py-2 text-left font-normal">자료</th>
            <th className="py-2 text-right font-normal">건수</th>
            <th className="py-2 text-right font-normal">분모</th>
            <th className="py-2 pl-4 text-left font-normal">뜻</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.src} className="border-b border-rule-soft align-top">
              <td className="py-2">{r.src}</td>
              <td className="addr tnum py-2 text-right">{fmt(r.n)}</td>
              <td className="addr tnum py-2 text-right text-ink-3">{r.d}</td>
              <td className="py-2 pl-4 text-ink-2">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DefectIllegal({ stats }: { stats: PolicyStats }) {
  const total = stats.coverage.find((c) => c.source_type === 'RECALL_OVERSEAS')?.total ?? 0;
  const accidents = stats.coverage.find((c) => c.source_type === 'ACCIDENT');
  const soCases = accidents?.second_opinion ?? 0;
  const kind = (k: string) => stats.kinds.find((x) => x.output_kind === k) ?? { rows: 0, cases: 0 };
  const route = (k: string) => stats.codes
    .filter((c) => c.axis === 'HF' && (c.route ?? 'NONE') === k)
    .reduce((a, c) => a + c.cases, 0);
  const latestRows = stats.kinds.reduce((a, k) => a + k.rows, 0);

  return (
    <section id="policy-defect" className="mt-12 scroll-mt-8">
      <h2 className="text-[17px] font-semibold">불량과 불법</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        <span className="text-ink">불량</span>은 시험을 해야 알고(산출물: 시험항목),{' '}
        <span className="text-ink">불법</span>은 법령을 보면 판정됩니다(산출물: 인증·표시 확인항목). 섞지 않으려고 표를 나눕니다.
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
        병행 점검은 사건마다 <span className="text-ink-2">가장 최근 실행</span>만 셉니다 — 최신 실행 소견{' '}
        {fmt(latestRows)}행 (전체 {fmt(stats.kindReviews.runs)}회 실행, 재실행 포함 누적 {fmt(stats.kindReviews.total_rows)}행).
        최신 소견 중 담당자가 판정한 것 {fmt(stats.kindReviews.reviewed)}건. 판정 전 소견은 모두 후보입니다.
      </p>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div>
          <h3 className="text-[14px] font-semibold">불량 — 시험으로 확인할 것</h3>
          <RouteTable rows={[
            {
              src: '사고 병행 점검: 시험 범위 공백 후보', n: kind('TEST_ITEM').rows,
              d: `사고 ${fmt(kind('TEST_ITEM').cases)} / ${fmt(soCases)}건`,
              note: '보고서가 하지 않은 시험 중 적용 기준에 있는 것. 의뢰할 시험의 후보이지 결함 판정이 아닙니다.',
            },
            {
              src: '해외 리콜: 대표 원인의 확인 경로가 「시험」', n: route('TEST'),
              d: `리콜 ${fmt(total)}건`, note: ROUTE.TEST.note,
            },
          ]} />
        </div>
        <div>
          <h3 className="text-[14px] font-semibold">불법 — 인증·표시로 확인할 것</h3>
          <RouteTable rows={[
            {
              src: '사고 병행 점검: 인증·표시 확인 후보', n: kind('CERT_MARKING_CHECK').rows,
              d: `사고 ${fmt(kind('CERT_MARKING_CHECK').cases)} / ${fmt(soCases)}건`,
              note: '보고서에 상이·불일치·미표시 같은 신호가 있는 것. 위반 여부는 인증기관·법령으로 확인합니다.',
            },
            {
              src: '해외 리콜: 대표 원인의 확인 경로가 「법령」', n: route('LEGAL'),
              d: `리콜 ${fmt(total)}건`, note: ROUTE.LEGAL.note,
            },
          ]} />
        </div>
      </div>
      <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
        어느 쪽에도 넣지 않은 것 — 해외 리콜 대표 원인 중 「{ROUTE.GAP.label}」 {fmt(route('GAP'))}건,
        「{ROUTE.OTHER.label}」 {fmt(route('OTHER'))}건, 확인 경로 미지정 {fmt(route('NONE'))}건.
        병행 점검의 관련 리콜 근거 {fmt(kind('REFERENCE').rows)}행은 참고 자료라 세지 않습니다.
      </p>
    </section>
  );
}

/* ── 4. 사각지대 후보 ───────────────────────────────────────── */

function BlindSpots({ stats }: { stats: PolicyStats }) {
  const s = stats.standards;
  return (
    <section id="policy-blind" className="mt-12 scroll-mt-8">
      <h2 className="text-[17px] font-semibold">사각지대 후보</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        병행 점검이 &ldquo;기준이 이 위해를 덮지 못할 수 있다&rdquo;고 표시한 사고입니다.{' '}
        <span className="text-ink">전문가가 확인하기 전에는 후보일 뿐입니다.</span> 원문 근거를 사건 화면에서 직접 보세요.
      </p>

      {stats.signals.length === 0 ? (
        <p className="mt-4 text-[12px] text-ink-3">최신 병행 점검 실행에 기준공백 신호가 없습니다.</p>
      ) : (
        <ul className="mt-4 border-t border-rule">
          {stats.signals.map((r) => (
            <li key={r.case_id} className="border-b border-rule-soft py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link href={`/analysis/${r.case_id}`} className="text-[13px] font-medium underline decoration-rule underline-offset-2 hover:text-measure">
                  {r.title ?? `사건 ${r.case_id}`}
                </Link>
                {r.needs_expert_confirm && (
                  <span className="border border-caution px-1.5 text-[11px] text-caution">전문가 확인 필요</span>
                )}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{r.rationale}</p>
              {r.evidence && (
                <blockquote className="mt-1 border-l-2 border-rule pl-2 text-[11px] leading-relaxed text-ink-3">
                  원문: {r.evidence.replace(/\s+/g, ' ')}
                </blockquote>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-8 text-[14px] font-semibold">해외 근거 표준 ↔ 국내 기준 번호 연결</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
        해외 리콜 {fmt(s.total)}건 중 근거 표준이 적힌 것 <span className="addr tnum text-ink">{fmt(s.cited)}건</span>
        ({pct(s.cited, s.total)}), 그중 국내 기준과 번호로 이어진 것{' '}
        <span className="addr tnum text-ink">{fmt(s.matched)}건</span> ({pct(s.matched, s.cited)}).
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
        못 이은 {fmt(s.cited - s.matched)}건은 &ldquo;국내 기준이 없다&rdquo;가 아닙니다. EN 71(완구)처럼 국내와 번호 체계가
        달라 번호로는 못 잇는 경우가 대부분이고, 사람이 판단할 몫입니다. 표준별 내역은 아래 「국내외 기준 대조」 표에 있습니다.
      </p>
    </section>
  );
}
