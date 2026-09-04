import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError } from '@/components/Panel';
import { PageToc, type TocItem } from '@/components/PageToc';

export const dynamic = 'force-dynamic';

const TOC: TocItem[] = [
  { id: 'insight-gap', label: '기준 사각지대' },
  { id: 'insight-compare', label: '국내외 대조' },
  { id: 'insight-test', label: '시험항목 사용' },
];

/**
 * 세 번째 산출물 — KC안전기준 개선 요인
 *
 * 이 화면이 하지 않는 것부터 적는다
 *   "기준이 낮다·높다", "강화해야 한다", "법적 의무가 있다"를 말하지 않는다.
 *   숫자와 그 숫자가 어디서 왔는지만 보여 준다. 판단은 담당 부서와 전문가가 한다.
 *   자동 보고서 문장도 만들지 않는다 — 표와 근거 목록까지가 시스템의 몫이다.
 *
 * 0 건의 뜻을 나누는 것이 이 화면의 전부다 (v0.7 §7.8)
 *   "대응 조항이 없다"와 "아직 분석을 안 했다"와 "품목이 확정되지 않았다"는 전혀
 *   다른 말인데 전부 0 으로 보인다. 그것을 섞으면 자료 누락이 정책 신호로 둔갑한다.
 *   그래서 모든 표를 상태별로 나누고, 사각지대 후보는 맨 마지막에 둔다 —
 *   먼저 걸러야 할 것을 걸러 낸 뒤에야 그 자리를 사각지대라고 부를 수 있다.
 *
 * 지금 표가 비어 있는 칸이 많은 것은 잘못이 아니다
 *   담당자의 검토 기록이 아직 0건이므로 "채택·반려" 칸은 비어 있다.
 *   그것이 지금의 사실이고, 비어 있다는 것 자체가 정보다. 숫자를 지어내지 않는다.
 */

/** 상태 이름과 그 뜻 — 이 화면의 값어치는 이 표에 다 들어 있다 */
const GAP_STATUS: Record<string, { label: string; note: string; tone: 'halt' | 'caution' | 'ink' | 'measure' }> = {
  SCOPE_UNRESOLVED: {
    label: '품목 미확정',
    note: '어떤 기준을 적용할지 정하지 못했습니다. 사각지대인지 아닌지 말할 수 없는 상태입니다.',
    tone: 'ink',
  },
  NOT_CODED: {
    label: '코드 미부여',
    note: '위해요인 코드가 없어 조항과 코드로 맞춰 볼 수 없습니다.',
    tone: 'ink',
  },
  NOT_ANALYZED: {
    label: '분석 미실행',
    note: '아직 분석을 돌리지 않았습니다.',
    tone: 'ink',
  },
  NOT_REVIEWED: {
    label: '검토 대기',
    note: '후보는 나왔으나 담당자가 아직 보지 않았습니다. 사각지대인지 오탐인지 판단이 없습니다.',
    tone: 'caution',
  },
  NO_CANDIDATE: {
    label: '대응 조항 없음',
    note: '분석했으나 관련될 수 있는 조항을 찾지 못했습니다. 사각지대 후보입니다.',
    tone: 'halt',
  },
  ALL_REJECTED: {
    label: '후보 전부 반려',
    note: '후보는 나왔으나 담당자가 모두 반려했습니다. 더 강한 사각지대 신호입니다.',
    tone: 'halt',
  },
  COVERED: {
    label: '대응 조항 있음',
    note: '담당자가 채택한 조항이 있습니다.',
    tone: 'measure',
  },
};

/** 사각지대 후보를 맨 아래 두기 위한 순서 — 걸러야 할 것을 먼저 보여 준다 */
const GAP_ORDER = [
  'SCOPE_UNRESOLVED', 'NOT_CODED', 'NOT_ANALYZED', 'NOT_REVIEWED',
  'COVERED', 'ALL_REJECTED', 'NO_CANDIDATE',
];

const COMPARE_STATUS: Record<string, { label: string; note: string }> = {
  NUMBER_MISMATCH: {
    label: '번호로 이어지지 않음',
    note: 'EN 71(완구)·GB 4706(중국 가전) 계열처럼 국내와 번호 체계가 다릅니다. '
      + '"국내에 기준이 없다"는 뜻이 아니라 번호로는 못 잇는다는 뜻입니다. 사람이 판단할 몫입니다.',
  },
  MATCHED_NO_DATA: {
    label: '이어지지만 비교할 수치 없음',
    note: '국내 기준과 번호가 이어집니다. 다만 그 기준에서 허용치·시험조건을 뽑아 두지 않아 '
      + '수준을 견줄 수가 없습니다. 원문을 사람이 봐야 합니다.',
  },
  COMPARABLE: {
    label: '비교 가능',
    note: '번호가 이어지고 국내 조항에 구조화된 수치가 있습니다. 전문가가 견줘 볼 수 있는 자리입니다.',
  },
};

const TEST_STATUS: Record<string, { label: string; note: string }> = {
  NEVER_PROPOSED: {
    label: '후보로 나온 적 없음',
    note: '관련 사고·리콜이 없었을 수도 있고, 분석을 아직 적게 돌렸을 수도 있습니다. 지금은 구별할 수 없습니다.',
  },
  NOT_REVIEWED: {
    label: '검토 대기',
    note: '후보로는 제시됐으나 담당자가 판단한 적이 없습니다.',
  },
  LOW_ADOPTION: {
    label: '채택된 적 없음',
    note: '제시됐는데 한 번도 채택되지 않았습니다. 다시 볼 후보입니다.',
  },
  IN_USE: { label: '사용 중', note: '채택된 적이 있습니다.' },
};

interface GapRow {
  source_type: string; scope_name: string; hf_code: string; dt_code: string;
  case_count: number; analyzed_count: number; candidate_total: number;
  adopted_total: number; rejected_total: number; status: string;
}
interface CompareRow {
  cited_standard: string; recall_country: string | null; recall_count: number;
  matched_standards: string[] | null; domestic_test_conditions: number; status: string;
}
interface TestRow {
  clause_id: number; marker: string; standard_name: string;
  requirement_count: number; proposed_count: number;
  adopted_count: number; rejected_count: number; status: string;
}

async function load() {
  const db = getDb();
  const [gapStatus, gapTop, cmpStatus, cmpTop, testStatus, testTop, reviewCount] = await Promise.all([
    db<{ status: string; groups: number; cases: number }[]>`
      select status, count(*)::int as groups, sum(case_count)::int as cases
      from public.insight_standard_gap group by status`,
    db<GapRow[]>`
      select * from public.insight_standard_gap
      -- 사각지대 후보를 먼저, 그다음 검토 대기, 그다음 나머지
      order by (status in ('NO_CANDIDATE','ALL_REJECTED')) desc,
               (status = 'NOT_REVIEWED') desc, case_count desc
      limit 25`,
    db<{ status: string; standards: number; recalls: number }[]>`
      select status, count(*)::int as standards, sum(recall_count)::int as recalls
      from public.insight_standard_comparison group by status`,
    db<CompareRow[]>`
      select * from public.insight_standard_comparison
      order by (status = 'COMPARABLE') desc, (status = 'MATCHED_NO_DATA') desc, recall_count desc
      limit 25`,
    db<{ status: string; methods: number }[]>`
      select status, count(*)::int as methods from public.insight_test_usage group by status`,
    db<TestRow[]>`
      select * from public.insight_test_usage
      order by (status = 'LOW_ADOPTION') desc, proposed_count desc, standard_name, marker
      limit 25`,
    db<{ n: number }[]>`select count(*)::int as n from public.review_log`,
  ]);
  return { gapStatus, gapTop, cmpStatus, cmpTop, testStatus, testTop, reviews: reviewCount[0].n };
}

function StatusTable({ rows }: { rows: Array<{ key: string; label: string; note: string; count: number; unit: string }> }) {
  return (
    <div className="mt-4 border-t border-rule">
      {rows.map((r) => (
        <div key={r.key} className="border-b border-rule-soft py-3">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-[13px] font-medium">{r.label}</span>
            <span className="addr tnum text-[13px]">{r.count.toLocaleString()}{r.unit}</span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{r.note}</p>
        </div>
      ))}
    </div>
  );
}

export default async function InsightsPage() {
  let data: Awaited<ReturnType<typeof load>> | null = null;
  let error: string | null = null;
  try {
    data = await load();
  } catch (e) {
    console.error('개선 요인 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_10rem]">
        <div>
          <PageHead
            label="산출물 3"
            title="KC안전기준 개선 요인"
            lead="사고·리콜과 담당자의 판단을 모아, 전문가가 다시 볼 자리를 찾습니다. 결론을 내지는 않습니다."
          />

          {error && <ConnectionError error={error} />}

          {data && (
            <>
              {/*
                이 화면의 한계를 맨 위에 적는다. 아래 표만 보면 "숫자가 있으니
                결론이 있다"고 읽기 쉽다. 지금 무엇이 없는지를 먼저 말해야 한다.
              */}
              <div className="mt-8 border border-caution bg-caution-soft px-4 py-3">
                <div className="text-[13px] font-semibold text-caution">이 표를 읽기 전에</div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                  이 화면은 <span className="text-ink">기준을 강화하거나 완화해야 한다고 말하지 않습니다.</span>{' '}
                  숫자와 그 출처만 보여 줍니다. 판단은 담당 부서와 전문가가 합니다.
                </p>
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                  담당자 검토 기록이{' '}
                  <span className="addr tnum text-ink">{data.reviews.toLocaleString()}건</span>
                  입니다.
                  {data.reviews === 0 && (
                    <>
                      {' '}채택·반려가 아직 하나도 없으므로 그 판단에 기대는 칸은 모두 비어 있습니다.
                      <Link href="/analysis" className="ml-1 underline decoration-rule underline-offset-2 hover:text-measure">
                        분석 결과를 검토
                      </Link>
                      하면 숫자가 생깁니다.
                    </>
                  )}
                </p>
              </div>

              {/* ── 1. 기준 사각지대 ─────────────────────────────── */}
              <section id="insight-gap" className="mt-10 scroll-mt-8">
                <h2 className="text-[17px] font-semibold">기준 사각지대</h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
                  사고·리콜을 품목과 위해요인 코드로 묶고, 그 묶음이 어디까지 갔는지 봅니다.
                  대응 조항이 없다고 말하려면 먼저 품목·코드·분석이 갖춰져 있어야 합니다.
                </p>

                <StatusTable
                  rows={GAP_ORDER.filter((k) => data!.gapStatus.some((s) => s.status === k)).map((k) => {
                    const s = data!.gapStatus.find((x) => x.status === k)!;
                    return {
                      key: k, label: GAP_STATUS[k]?.label ?? k, note: GAP_STATUS[k]?.note ?? '',
                      count: s.cases, unit: '건',
                    };
                  })}
                />

                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[46rem] text-[12px]">
                    <thead className="label border-b border-rule">
                      <tr>
                        <th className="py-2 text-left font-normal">품목</th>
                        <th className="py-2 text-left font-normal">위해요인</th>
                        <th className="py-2 text-left font-normal">피해유형</th>
                        <th className="py-2 text-right font-normal">사건</th>
                        <th className="py-2 text-right font-normal">분석</th>
                        <th className="py-2 text-right font-normal">후보</th>
                        <th className="py-2 text-right font-normal">채택</th>
                        <th className="py-2 text-left font-normal">상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.gapTop.map((r, i) => (
                        <tr key={i} className="border-b border-rule-soft">
                          <td className="py-2">{r.scope_name}</td>
                          <td className="addr py-2">{r.hf_code}</td>
                          <td className="addr py-2">{r.dt_code}</td>
                          <td className="addr tnum py-2 text-right">{r.case_count}</td>
                          <td className="addr tnum py-2 text-right">{r.analyzed_count}</td>
                          <td className="addr tnum py-2 text-right">{r.candidate_total}</td>
                          <td className="addr tnum py-2 text-right">{r.adopted_total}</td>
                          <td className={`py-2 text-${GAP_STATUS[r.status]?.tone ?? 'ink'}`}>
                            {GAP_STATUS[r.status]?.label ?? r.status}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* ── 2. 국내외 대조 ─────────────────────────────── */}
              <section id="insight-compare" className="mt-12 scroll-mt-8">
                <h2 className="text-[17px] font-semibold">국내외 기준 대조</h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
                  해외가 리콜의 근거로 든 표준이 국내 기준과 이어지는지 봅니다.
                  <span className="text-ink"> 수준의 높낮이는 판정하지 않습니다</span> —
                  견줄 수 있는 자리인지까지만 말합니다.
                </p>

                <StatusTable
                  rows={['COMPARABLE', 'MATCHED_NO_DATA', 'NUMBER_MISMATCH']
                    .filter((k) => data!.cmpStatus.some((s) => s.status === k))
                    .map((k) => {
                      const s = data!.cmpStatus.find((x) => x.status === k)!;
                      return {
                        key: k, label: COMPARE_STATUS[k].label, note: COMPARE_STATUS[k].note,
                        count: s.recalls, unit: '건',
                      };
                    })}
                />

                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[42rem] text-[12px]">
                    <thead className="label border-b border-rule">
                      <tr>
                        <th className="py-2 text-left font-normal">해외 표준</th>
                        <th className="py-2 text-left font-normal">국가</th>
                        <th className="py-2 text-right font-normal">리콜</th>
                        <th className="py-2 text-left font-normal">대조된 국내 기준</th>
                        <th className="py-2 text-right font-normal">국내 허용치</th>
                        <th className="py-2 text-left font-normal">상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cmpTop.map((r, i) => (
                        <tr key={i} className="border-b border-rule-soft">
                          <td className="addr py-2">{r.cited_standard}</td>
                          <td className="py-2">{r.recall_country ?? '—'}</td>
                          <td className="addr tnum py-2 text-right">{r.recall_count}</td>
                          <td className="py-2">
                            {r.matched_standards?.length ? r.matched_standards.join(', ') : '—'}
                          </td>
                          <td className="addr tnum py-2 text-right">{r.domestic_test_conditions}</td>
                          <td className="py-2 text-ink-2">{COMPARE_STATUS[r.status]?.label ?? r.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* ── 3. 시험항목 사용 현황 ───────────────────────── */}
              <section id="insight-test" className="mt-12 scroll-mt-8">
                <h2 className="text-[17px] font-semibold">시험항목 사용 현황</h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
                  시험방법 조항이 후보로 얼마나 제시됐고 얼마나 채택됐는지 봅니다.
                  <span className="text-ink"> &ldquo;채택이 적다&rdquo;와 &ldquo;사고가 없다&rdquo;는 다른 말입니다.</span>
                </p>

                <StatusTable
                  rows={['LOW_ADOPTION', 'NOT_REVIEWED', 'IN_USE', 'NEVER_PROPOSED']
                    .filter((k) => data!.testStatus.some((s) => s.status === k))
                    .map((k) => {
                      const s = data!.testStatus.find((x) => x.status === k)!;
                      return {
                        key: k, label: TEST_STATUS[k].label, note: TEST_STATUS[k].note,
                        count: s.methods, unit: '개',
                      };
                    })}
                />

                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-[12px]">
                    <thead className="label border-b border-rule">
                      <tr>
                        <th className="py-2 text-left font-normal">시험방법 조항</th>
                        <th className="py-2 text-left font-normal">기준</th>
                        <th className="py-2 text-right font-normal">연결 요건</th>
                        <th className="py-2 text-right font-normal">제시</th>
                        <th className="py-2 text-right font-normal">채택</th>
                        <th className="py-2 text-right font-normal">반려</th>
                        <th className="py-2 text-left font-normal">상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.testTop.map((r) => (
                        <tr key={r.clause_id} className="border-b border-rule-soft">
                          <td className="addr py-2">{r.marker}</td>
                          <td className="py-2">{r.standard_name}</td>
                          <td className="addr tnum py-2 text-right">{r.requirement_count}</td>
                          <td className="addr tnum py-2 text-right">{r.proposed_count}</td>
                          <td className="addr tnum py-2 text-right">{r.adopted_count}</td>
                          <td className="addr tnum py-2 text-right">{r.rejected_count}</td>
                          <td className="py-2 text-ink-2">{TEST_STATUS[r.status]?.label ?? r.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <p className="mt-10 text-[11px] leading-relaxed text-ink-3">
                이 표는 지금 이 순간의 원자료를 그대로 집계한 것입니다. 자료가 바뀌면 숫자도 바뀝니다.
                보고에 쓸 수치를 시점째로 고정하는 기능(집계 스냅샷)은 아직 없습니다.
              </p>
            </>
          )}
        </div>
        <PageToc items={TOC} />
      </div>
    </div>
  );
}
