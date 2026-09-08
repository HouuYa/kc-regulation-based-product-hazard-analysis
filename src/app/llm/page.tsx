import Link from 'next/link';
import { PageHead, ConnectionError } from '@/components/Panel';
import { PageToc, type TocItem } from '@/components/PageToc';
import { callSitesWithModels } from '@/lib/llm/catalog';
import { formatCost, priceTable } from '@/lib/llm/pricing';
import {
  usageSummary, dailyUsage, recentCalls, PURPOSE_LABEL,
  type UsageSummary, type DayUsage, type RecentCall,
} from '@/lib/llm/usage';

export const dynamic = 'force-dynamic';

/**
 * 🤖 AI 사용 — 어디에 어떤 모델을 쓰고, 얼마가 드는가 (2026-09-08)
 *
 * 왜 운영에서 떼어 냈나
 *   운영은 「지금 제대로 돌고 있는가」를 보는 자리다. AI 는 그것과 성격이 다르다 —
 *   무엇을 물어보고 있고, 답을 어떻게 받고, 근거가 어디 남고, 돈이 얼마나 드는지는
 *   상태 점검이 아니라 **관리 대상**이다. 운영 화면 한 절에 눌러 담으면 표 하나로
 *   줄어들고, 그러면 "어디에 어떤 모델을 쓰나"에 답할 수 없다.
 *
 * 이 화면이 답해야 하는 것 다섯
 *   1. 어디에 AI 를 부르나 — 자리마다 무엇을 묻고 어떤 모델을 쓰는가
 *   2. 답을 어떻게 받나 — 구조화 출력 스키마와 enum 고정 여부
 *   3. 판단 근거가 어디 남나 — 검수가 「그저 믿는 일」이 되지 않으려면 필요하다
 *   4. 얼마 썼나 · 무엇이 비싼가
 *   5. 늘고 있나 — 날짜별 추이
 */

const TOC: TocItem[] = [
  { id: 'llm-summary', label: '한눈에' },
  { id: 'llm-sites', label: '어디에 어떤 모델' },
  { id: 'llm-cost', label: '용도별 비용' },
  { id: 'llm-models', label: '모델별 비용' },
  { id: 'llm-daily', label: '날짜별 추이' },
  { id: 'llm-prices', label: '단가표' },
  { id: 'llm-recent', label: '최근 호출' },
];

interface Data {
  usage: UsageSummary;
  daily: DayUsage[];
  recent: RecentCall[];
}

async function load(): Promise<{ data: Data | null; error: string | null }> {
  try {
    const [usage, daily, recent] = await Promise.all([
      usageSummary(30), dailyUsage(14), recentCalls(20),
    ]);
    return { data: { usage, daily, recent }, error: null };
  } catch (e) {
    // 화면은 "자세한 원인은 서버 기록에 남았습니다"라고 말한다. 실제로 남겨야 그 말이 참이 된다
    console.error('AI 사용 현황 조회 실패:', e);
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function Signal({
  label, value, level, note,
}: { label: string; value: string; level: 'ok' | 'caution' | 'halt'; note?: string }) {
  const tone = level === 'halt' ? 'text-halt' : level === 'caution' ? 'text-caution' : 'text-measure';
  const dot = level === 'halt' ? 'bg-halt' : level === 'caution' ? 'bg-caution' : 'bg-measure';
  return (
    <div className="border-t border-rule py-3">
      <div className="flex items-baseline gap-2">
        <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="label">{label}</span>
      </div>
      <div className={`mt-1 text-[14px] font-medium ${tone}`}>{value}</div>
      {note && <div className="mt-1 text-[11px] leading-snug text-ink-3">{note}</div>}
    </div>
  );
}

function Section({
  id, title, lead, children,
}: { id: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-12 scroll-mt-8">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {lead && <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-ink-2">{lead}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const n = (v: number) => v.toLocaleString();

function when(iso: string | null): string {
  if (!iso) return '기록 없음';
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

export default async function LlmPage() {
  const { data, error } = await load();
  const sites = callSitesWithModels();
  const prices = priceTable();

  // 캐시 적중률 — 입력 토큰 중 얼마가 싸게 청구됐나(054)
  const hitRate = data && data.usage.totalInput > 0
    ? (data.usage.totalCached / data.usage.totalInput) * 100
    : 0;

  const maxDay = data ? Math.max(1, ...data.daily.map((d) => d.inputTokens + d.outputTokens)) : 1;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_10rem]">
        <div>
          <PageHead
            label="🤖 AI 사용"
            title="어디에 어떤 모델을 쓰고, 얼마가 드는가"
            lead="이 시스템은 정해진 자리에서만 AI를 부릅니다. 어느 조항이 걸리는지는 SQL이 계산하고, AI는 뜻을 옮기거나 후보를 걸러내는 일만 합니다. 그 자리와 비용을 여기서 봅니다."
            workflow={[
              { label: 'AI를 부름', href: '#llm-sites', note: '정해진 자리에서만', state: 'done' },
              { label: '호출을 기록', note: '토큰·비용·근거', state: 'done' },
              { label: '비용으로 환산', href: '#llm-cost', note: '단가표로', state: 'done' },
              { label: '비싼 자리 손보기', who: '사람', href: '#llm-daily', state: 'here' },
            ]}
          />

          {error && <ConnectionError error={error} />}

          {data && (
            <>
              {/* ── 1. 한눈에 ───────────────────────────────────── */}
              <Section
                id="llm-summary"
                title="한눈에 (최근 30일)"
                lead="기록은 2026-09-07부터 쌓기 시작했습니다. 그 전에 돌린 작업은 여기에 나오지 않습니다."
              >
                <div className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-4">
                  <Signal
                    label="부른 횟수"
                    value={`${n(data.usage.totalCalls)}회`}
                    level={data.usage.totalFailed > 0 ? 'caution' : 'ok'}
                    note={data.usage.totalFailed > 0
                      ? `실패 ${n(data.usage.totalFailed)}회 포함 — 실패해도 입력 토큰은 나갔습니다`
                      : '실패 없음'}
                  />
                  <Signal
                    label="비용"
                    value={formatCost(data.usage.knownCost)}
                    level={data.usage.unpricedModels.length > 0 ? 'caution' : 'ok'}
                    note={data.usage.unpricedModels.length > 0
                      ? `${data.usage.unpricedModels.join(', ')} 단가가 없어 빠졌습니다`
                      : '짧은 문맥 단가와 긴 문맥 단가를 모두 계산한 범위입니다'}
                  />
                  <Signal
                    label="캐시 적중"
                    value={data.usage.totalCached > 0 ? `${hitRate.toFixed(1)}%` : '0%'}
                    level={data.usage.totalCached > 0 ? 'ok' : 'caution'}
                    note={data.usage.totalCached > 0
                      ? `입력 ${n(data.usage.totalInput)} 중 ${n(data.usage.totalCached)} 토큰이 1/10 단가`
                      : `적중 0 · 기록 ${n(data.usage.totalCacheWrite)} 토큰 — 쓰기만 하고 읽지 못하는 중입니다`}
                  />
                  <Signal label="마지막 호출" value={when(data.usage.lastCallAt)} level="ok" />
                </div>

                {data.usage.totalCacheWrite > 0 && data.usage.totalCached === 0 && (
                  <div className="mt-4 border border-caution bg-caution-soft px-4 py-3 text-[12px] leading-relaxed text-ink-2">
                    <span className="font-semibold text-caution">캐시에 쓰기만 하고 한 번도 읽지 못했습니다.</span>{' '}
                    입력 {n(data.usage.totalInput)} 토큰 중 {n(data.usage.totalCacheWrite)} 토큰이 캐시에
                    기록됐는데 적중은 0건입니다. 단가표상 캐시 기록은 일반 입력보다 비싸고
                    (gpt-5.6-terra 기준 $2.50 대 $2.00) 적중은 1/10 입니다 — 즉 지금은 할인을 못 받으면서 웃돈만 낼 수 있는
                    상태입니다. 같은 프롬프트로 세 번 연속 부르고, 60초·3분 뒤에 다시 불러도 적중이
                    잡히지 않았습니다(2026-09-08 실측). 계정에서 프롬프트 캐시가 켜져 있는지 확인이
                    필요합니다.
                  </div>
                )}

                {data.usage.unpricedModels.length > 0 && (
                  <div className="mt-4 border border-caution bg-caution-soft px-4 py-3 text-[12px] leading-relaxed text-ink-2">
                    <span className="font-semibold text-caution">금액이 실제보다 적게 보입니다.</span>{' '}
                    단가를 모르는 모델({data.usage.unpricedModels.join(', ')})은 0원으로 세지 않고
                    아예 뺐습니다. 모르는 값을 0으로 적으면 &ldquo;얼마 안 드네&rdquo;라고 잘못
                    판단하게 되기 때문입니다. <code className="addr">.env.local</code>의{' '}
                    <code className="addr">LLM_PRICES</code>에 100만 토큰당 달러로 넣으면 계산합니다.
                  </div>
                )}
              </Section>

              {/* ── 2. 어디에 어떤 모델 ─────────────────────────── */}
              <Section
                id="llm-sites"
                title="AI를 부르는 자리"
                lead="이 표는 코드에서 옵니다(src/lib/llm/catalog.ts). 손으로 적은 표는 코드가 바뀌면 조용히 틀리기 때문입니다. 모델 이름은 지금 이 배포에 설정된 값입니다."
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[64rem] border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-rule text-left text-ink-3">
                        <th className="py-2 pr-4 font-normal">무엇을 묻나</th>
                        <th className="py-2 pr-4 font-normal">언제</th>
                        <th className="py-2 pr-4 font-normal">모델</th>
                        <th className="py-2 pr-4 font-normal">고를 대상 고정(enum)</th>
                        <th className="py-2 pr-4 font-normal">근거 필드</th>
                        <th className="py-2 font-normal">DB 저장 위치</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sites.map((s) => (
                        <tr key={s.purpose} className="border-b border-rule-soft align-top">
                          <td className="py-2 pr-4">
                            <div className="text-ink">{s.name}</div>
                            <div className="mt-0.5 text-[11px] leading-snug text-ink-3">{s.goal}</div>
                            <div className="mt-0.5 text-[11px] text-ink-3">
                              스키마 <code className="addr">{s.schema}</code>
                            </div>
                          </td>
                          <td className="py-2 pr-4 text-ink-2">{s.when}</td>
                          <td className="py-2 pr-4">
                            {s.models.map((m) => (
                              <div key={m} className="text-ink-2">{m}</div>
                            ))}
                            <div className="mt-0.5 text-[11px] text-ink-3">{s.modelEnv}</div>
                          </td>
                          <td className="py-2 pr-4 text-ink-2">{s.enumLock}</td>
                          <td className="py-2 pr-4 text-ink-2">{s.evidence}</td>
                          <td className="py-2 text-[11px] text-ink-3">{s.storedAt}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 max-w-3xl text-[12px] leading-relaxed text-ink-3">
                  「고를 대상 고정」이 이 체계에서 가장 중요한 안전장치입니다. 답을 자유
                  서술로 받지 않고 고를 수 있는 것을 목록으로 못박으면, 존재하지 않는 기준이나
                  코드북에 없는 코드를 **만들어 낼 수 없습니다**. 가장 나쁜 고장은 그럴듯한
                  오답이고, 그것은 담당자가 검수해도 걸러내기 어렵기 때문입니다.
                </p>
              </Section>

              {/* ── 3. 용도별 비용 ──────────────────────────────── */}
              <Section
                id="llm-cost"
                title="무엇이 비싼가 (용도별)"
                lead="줄이고 싶다면 출력이 아니라 넣는 원문의 길이를 손봐야 합니다 — 이 체계는 입력 토큰이 출력의 스무 배가 넘습니다."
              >
                {data.usage.rows.length === 0 ? (
                  <div className="border border-rule-soft px-4 py-3 text-[12px] text-ink-2">
                    아직 기록이 없습니다.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[52rem] border-collapse text-[12px]">
                      <thead>
                        <tr className="border-b border-rule text-left text-ink-3">
                          <th className="py-2 pr-4 font-normal">어디에</th>
                          <th className="py-2 pr-4 font-normal">모델</th>
                          <th className="py-2 pr-4 text-right font-normal">횟수</th>
                          <th className="py-2 pr-4 text-right font-normal">입력</th>
                          <th className="py-2 pr-4 text-right font-normal">캐시 적중</th>
                          <th className="py-2 pr-4 text-right font-normal">출력</th>
                          <th className="py-2 text-right font-normal">비용</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.usage.rows.map((r) => {
                          const label = PURPOSE_LABEL[r.purpose];
                          return (
                            <tr key={`${r.purpose}-${r.model}`} className="border-b border-rule-soft align-top">
                              <td className="py-2 pr-4">
                                <div className="text-ink">{label?.name ?? r.purpose}</div>
                                {label && <div className="mt-0.5 text-[11px] text-ink-3">{label.where}</div>}
                              </td>
                              <td className="py-2 pr-4 text-ink-2">{r.model}</td>
                              <td className="py-2 pr-4 text-right tabular-nums">
                                {n(r.calls)}
                                {r.failed > 0 && <span className="ml-1 text-caution">실패 {r.failed}</span>}
                                {r.items > r.calls && (
                                  <div className="text-[11px] text-ink-3">묶음 {n(r.items)}건</div>
                                )}
                              </td>
                              <td className="py-2 pr-4 text-right tabular-nums text-ink-2">{n(r.inputTokens)}</td>
                              <td className="py-2 pr-4 text-right tabular-nums text-ink-3">
                                {r.cachedTokens > 0
                                  ? `${n(r.cachedTokens)} (${((r.cachedTokens / Math.max(1, r.inputTokens)) * 100).toFixed(0)}%)`
                                  : '—'}
                                {r.cacheWriteTokens > 0 && (
                                  <div className="text-[11px] text-caution">기록 {n(r.cacheWriteTokens)}</div>
                                )}
                              </td>
                              <td className="py-2 pr-4 text-right tabular-nums text-ink-2">
                                {n(r.outputTokens)}
                                {r.reasoningTokens > 0 && (
                                  <div className="text-[11px] text-ink-3">생각 {n(r.reasoningTokens)}</div>
                                )}
                              </td>
                              <td className="py-2 text-right tabular-nums">{formatCost(r.costUsd)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
                  「생각」은 추론 모델이 속으로 쓴 토큰입니다. 출력 토큰에 이미 포함되어 청구되므로
                  따로 더하지 않습니다. 「캐시 적중」은 같은 프롬프트 앞부분을 다시 보내 1/10 단가로
                  청구된 입력입니다. 임베딩은 한 번에 여러 건을 묶어 보내므로 호출 횟수보다 처리
                  건수(묶음)가 많습니다.
                </p>
              </Section>

              {/* ── 4. 모델별 ───────────────────────────────────── */}
              <Section
                id="llm-models"
                title="모델별"
                lead="모델을 바꾸면 결과도 바뀝니다. 무엇으로 만든 결과인지 되짚을 수 있도록 만든 결과에 모델명을 함께 저장합니다."
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-rule text-left text-ink-3">
                        <th className="py-2 pr-4 font-normal">모델</th>
                        <th className="py-2 pr-4 text-right font-normal">횟수</th>
                        <th className="py-2 pr-4 text-right font-normal">입력</th>
                        <th className="py-2 pr-4 text-right font-normal">출력</th>
                        <th className="py-2 text-right font-normal">비용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.usage.byModel.map((r) => (
                        <tr key={r.model} className="border-b border-rule-soft">
                          <td className="py-2 pr-4 text-ink">{r.model}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{n(r.calls)}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-ink-2">{n(r.inputTokens)}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-ink-2">{n(r.outputTokens)}</td>
                          <td className="py-2 text-right tabular-nums">{formatCost(r.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              {/* ── 5. 날짜별 ───────────────────────────────────── */}
              <Section
                id="llm-daily"
                title="날짜별 (최근 14일)"
                lead="막대는 그날 쓴 토큰(입력+출력)입니다. 배치를 돌린 날이 튀는 것이 정상이고, 아무도 아무것도 안 했는데 튀면 볼 일이 생긴 것입니다."
              >
                {data.daily.length === 0 ? (
                  <div className="border border-rule-soft px-4 py-3 text-[12px] text-ink-2">
                    최근 14일 안에는 호출이 없습니다.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {data.daily.map((d) => {
                      const total = d.inputTokens + d.outputTokens;
                      return (
                        <div key={d.day} className="flex items-center gap-3 text-[12px]">
                          <span className="addr w-20 shrink-0 text-ink-3">{d.day.slice(5)}</span>
                          <span className="h-3 shrink-0 bg-measure" style={{ width: `${(total / maxDay) * 60}%` }} />
                          <span className="tabular-nums text-ink-2">{n(total)} 토큰</span>
                          <span className="tabular-nums text-ink-3">· {n(d.calls)}회</span>
                          {d.failed > 0 && <span className="text-caution">실패 {d.failed}</span>}
                          <span className="tabular-nums text-ink-3">· {formatCost(d.cost)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Section>

              {/* ── 6. 단가표 ───────────────────────────────────── */}
              <Section
                id="llm-prices"
                title="지금 쓰고 있는 단가"
                lead="단가는 코드에 박지 않고 환경변수(LLM_PRICES)로 받습니다. 코드에 박아 두면 어느 시점의 값인지 알 수 없게 되고, 낡은 단가로 계산한 금액이 맞는 값처럼 화면에 뜨기 때문입니다."
              >
                {Object.keys(prices).length === 0 ? (
                  <div className="border border-caution bg-caution-soft px-4 py-3 text-[12px] leading-relaxed text-ink-2">
                    단가가 하나도 등록되어 있지 않습니다. 금액은 모두 「단가 미등록」으로 나옵니다.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[44rem] border-collapse text-[12px]">
                      <thead>
                        <tr className="border-b border-rule text-left text-ink-3">
                          <th className="py-2 pr-4 font-normal">모델</th>
                          <th className="py-2 pr-4 text-right font-normal">입력</th>
                          <th className="py-2 pr-4 text-right font-normal">캐시 적중</th>
                          <th className="py-2 pr-4 text-right font-normal">캐시 기록</th>
                          <th className="py-2 pr-4 text-right font-normal">출력</th>
                          <th className="py-2 pr-4 text-right font-normal">긴 문맥 입력</th>
                          <th className="py-2 text-right font-normal">긴 문맥 출력</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(prices).map(([model, p]) => (
                          <tr key={model} className="border-b border-rule-soft">
                            <td className="py-2 pr-4 text-ink">{model}</td>
                            <td className="py-2 pr-4 text-right tabular-nums text-ink-2">${p.input.toFixed(2)}</td>
                            <td className="py-2 pr-4 text-right tabular-nums text-ink-2">
                              {p.cachedInput === undefined ? '—' : `$${p.cachedInput.toFixed(2)}`}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums text-caution">
                              {p.cacheWrite === undefined ? '—' : `$${p.cacheWrite.toFixed(2)}`}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums text-ink-2">
                              {p.output === undefined ? '—' : `$${p.output.toFixed(2)}`}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums text-ink-3">
                              {p.inputLong === undefined ? '—' : `$${p.inputLong.toFixed(2)}`}
                            </td>
                            <td className="py-2 text-right tabular-nums text-ink-3">
                              {p.outputLong === undefined ? '—' : `$${p.outputLong.toFixed(2)}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="mt-3 max-w-3xl text-[12px] leading-relaxed text-ink-3">
                  100만 토큰당 미국 달러입니다. 어느 길이부터 「긴 문맥」인지는 단가표에 적혀 있지
                  않아, 화면은 짧은 쪽과 긴 쪽을 모두 계산해 범위로 보여 줍니다. 정확한 한 숫자를
                  지어내는 것보다 「이 사이」라고 말하는 편이 정직하기 때문입니다. 「캐시 기록」이
                  실제로 청구되는지도 확인하지 못해 같은 방식으로 범위에 담았습니다 — 낮은 쪽은
                  일반 입력으로, 높은 쪽은 기록 단가로 계산합니다.
                </p>
              </Section>

              {/* ── 7. 최근 호출 ────────────────────────────────── */}
              <Section
                id="llm-recent"
                title="최근 호출 20건"
                lead="방금 돌린 작업이 실제로 무엇을 불렀는지 확인하는 자리입니다. 실패한 호출도 함께 보입니다 — 입력 토큰은 이미 나갔기 때문입니다."
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[48rem] border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-rule text-left text-ink-3">
                        <th className="py-2 pr-4 font-normal">시각</th>
                        <th className="py-2 pr-4 font-normal">어디에</th>
                        <th className="py-2 pr-4 font-normal">모델</th>
                        <th className="py-2 pr-4 text-right font-normal">입력</th>
                        <th className="py-2 pr-4 text-right font-normal">출력</th>
                        <th className="py-2 font-normal">대상 · 결과</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map((c, i) => (
                        <tr key={`${c.at}-${i}`} className="border-b border-rule-soft align-top">
                          <td className="py-2 pr-4 whitespace-nowrap text-ink-3">{when(c.at)}</td>
                          <td className="py-2 pr-4 text-ink">{PURPOSE_LABEL[c.purpose]?.name ?? c.purpose}</td>
                          <td className="py-2 pr-4 text-ink-2">{c.model}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-ink-2">{n(c.inputTokens)}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-ink-2">{n(c.outputTokens)}</td>
                          <td className="py-2 text-ink-3">
                            {c.caseId !== null && (
                              <Link href={`/analysis/${c.caseId}`} className="underline underline-offset-2 hover:text-measure">
                                사건 {c.caseId}
                              </Link>
                            )}
                            {c.standardId !== null && <span className="ml-2">기준 {c.standardId}</span>}
                            {!c.ok && <span className="ml-2 text-caution">실패 {(c.error ?? '').slice(0, 60)}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
                  「대상」은 어느 사건·기준을 처리하다 부른 것인지입니다. 054부터 남기므로 그 전에
                  쌓인 기록은 비어 있습니다.
                </p>
              </Section>
            </>
          )}
        </div>

        <PageToc items={TOC} />
      </div>
    </div>
  );
}
