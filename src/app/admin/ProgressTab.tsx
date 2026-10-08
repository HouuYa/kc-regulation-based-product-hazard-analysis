import Link from 'next/link';
import { getDb } from '@/lib/db';
import { ConnectionError } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { AutoRefresh } from '@/components/AutoRefresh';
import { PageToc, type TocItem } from '@/components/PageToc';
import { Section } from '@/components/AdminParts';
import { load as loadAccidents, UPLOAD_STEPS } from '../accidents/data';
import { load as loadRecalls } from '../recalls/data';

/**
 * 관리 · 진척 현황 탭 (P3-6)
 *
 * 옛 사고보고서 현황(/accidents/status)과 리콜 현황(/recalls/status)의 숫자를
 * 이 자리로 모았다. 두 화면 모두 결정 버튼이 없는 읽기 전용이었다 — 처리하는
 * 사람에게는 「처리할 것」 목록이 먼저이고, 전체가 어디까지 왔는지는 관리하는
 * 사람이 보는 숫자다.
 *
 * 조회는 각 화면의 data.ts 를 그대로 가져다 쓴다(CLAUDE.md §9). 복사해 두면 집계
 * 기준이 바뀔 때 한쪽만 고치게 된다. load 가 목록까지 한 번에 읽도록 짜여 있어
 * 목록도 함께 불러오지만(§4.1) 여기서는 요약만 그린다.
 */

const TOC: TocItem[] = [
  { id: 'progress-accidents', label: '사고보고서' },
  { id: 'progress-recalls', label: '리콜' },
  { id: 'progress-setup', label: '처음 설치할 때' },
];

export async function ProgressTab() {
  let accidents: Awaited<ReturnType<typeof loadAccidents>> | null = null;
  let recalls: Awaited<ReturnType<typeof loadRecalls>> | null = null;
  let hasClauses = true;
  let error: string | null = null;
  try {
    [accidents, recalls] = await Promise.all([loadAccidents({}), loadRecalls({})]);
    const [c] = await getDb()<{ ok: boolean }[]>`select exists (select 1 from public.clause) as ok`;
    hasClauses = c.ok;
  } catch (e) {
    console.error('관리 화면(진척 현황) 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  const a = accidents?.summary;
  const r = recalls?.summary;

  return (
    <>
      {error && <ConnectionError error={error} />}

      {a && (
        <Section
          id="progress-accidents"
          title="사고보고서"
          lead="올린 PDF가 글자 검사·원문 확인·코드·의미 검색 준비·분석·채택의 어느 걸음까지 왔는지입니다."
        >
          <StatusBar
            items={[
              { label: '올린 문서', value: a.files, note: '사고조사보고서 PDF' },
              {
                label: '추출 오류', value: a.fileErrors, wantsZero: true,
                note: '글자가 없는 스캔본이거나 개인정보가 들어 있는 문서입니다. 분석까지 가지 않습니다',
              },
              {
                label: '원문 확인함', value: a.confirmed, of: a.cases,
                note: '뽑아낸 글자를 담당자가 직접 확인한 문서입니다. 확인해야 분석할 수 있습니다',
              },
              {
                label: '위해요인 코드', value: a.coded, of: a.cases,
                note: '원인(HF)과 피해유형(DT) 코드가 붙은 사고',
              },
              {
                label: '의미 검색 준비', value: a.embedded, of: a.cases,
                note: '단어가 달라도 뜻이 비슷한 조항까지 찾아냅니다. 새로 들어온 자료는 저절로 준비됩니다',
              },
              {
                label: '분석 실행됨', value: a.analyzed, of: a.cases,
                note: '관련될 수 있는 조항을 찾아 순위까지 매긴 사고',
              },
              {
                label: '채택된 조항', value: a.adopted,
                note: '담당자가 "관련 있다"고 확인한 조항입니다. 이 기록으로 정확도를 잽니다',
              },
            ]}
          />

          {/* 올린 뒤 무슨 일이 일어나는가 (담당자 요청, 2026-09-09) */}
          <details className="mt-4 border border-rule-soft">
            <summary className="cursor-pointer px-4 py-2.5 text-[12px] text-ink-2">
              올린 뒤 무슨 일이 일어나는지 — 여섯 걸음 중{' '}
              <span className="text-ink">사람이 할 일은 두 걸음</span>입니다
            </summary>
            <div className="border-t border-rule-soft px-4 py-3.5">
              {UPLOAD_STEPS.map((st) => (
                <div key={st.no} className="flex gap-3 border-t border-rule-soft py-2 first:border-t-0">
                  <span className="addr tnum w-4 shrink-0 text-[12px] text-ink-3">{st.no}</span>
                  <div className="min-w-0">
                    <div className="text-[12px]">
                      <span className="font-medium">{st.name}</span>
                      <span
                        className={`ml-2 border px-1 text-[10px] ${
                          st.who === '자동' ? 'border-rule text-ink-3' : 'border-measure text-measure'
                        }`}
                      >
                        {st.who}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">{st.what}</p>
                  </div>
                </div>
              ))}
              <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
                걸음 3 에서 멈춰 있는 파일은 다음으로 가지 않습니다. 뽑아낸 글자가 원본과
                다른데 그대로 분석하면, 없는 사고를 분석하는 셈이 되기 때문입니다.
              </p>
            </div>
          </details>

          <p className="mt-3 text-[12px] text-ink-3">
            처리는{' '}
            <Link href="/accidents" className="underline decoration-rule underline-offset-2 hover:text-measure">
              사고보고서 화면
            </Link>
            에서 합니다.
          </p>
        </Section>
      )}

      {r && (
        <Section
          id="progress-recalls"
          title="리콜"
          lead="들어온 리콜이 코드·의미 검색 준비·분석·국내 유통 확인의 어느 걸음까지 왔는지입니다."
        >
          <StatusBar
            items={[
              { label: '해외 리콜', value: r.overseas, note: '협회 담당자가 승인한 것만 가져옵니다' },
              { label: '국내 리콜', value: r.domestic, note: '국내에서 공고된 리콜' },
              {
                label: '국내 유통 확인 대기', value: r.uncheckedDistribution, wantsZero: true,
                note: '해외에서 리콜된 제품이 국내에도 풀렸는지는 담당자가 직접 확인해야 합니다. 이걸 알아야 보고 의무가 있는지 따질 수 있습니다',
              },
              {
                label: '의미 검색 준비', value: r.embedded, of: r.cases,
                note: '단어가 달라도 뜻이 비슷한 조항까지 찾아냅니다. 새로 들어온 자료는 저절로 준비됩니다',
              },
              {
                label: '분석 실행됨', value: r.analyzed, of: r.cases,
                note: '관련될 수 있는 조항을 찾아 순위까지 매긴 리콜',
              },
              {
                // 담당자 요청으로 맨 뒤로 옮겼다 — 앞줄 끝에 혼자 남아 아랫줄이
                // 비어 보이던 자리를 메운다
                label: '위해요인 코드', value: r.coded, of: r.cases,
                note: '원인(HF)과 피해유형(DT) 코드가 붙은 리콜',
              },
            ]}
          />

          <p className="mt-3 text-[12px] text-ink-3">
            처리는{' '}
            <Link href="/recalls" className="underline decoration-rule underline-offset-2 hover:text-measure">
              리콜 화면
            </Link>
            에서 합니다.
          </p>
        </Section>
      )}

      {/* 준비가 밀려 있으면 숫자가 계속 바뀐다 — 새로고침을 사람이 누르지 않게 한다 */}
      {a && r && (
        <div className="mt-4">
          <AutoRefresh
            active={a.embedded < a.cases || r.embedded < r.cases}
            seconds={20}
            label="의미 검색 준비가 진행 중입니다 — 숫자가 저절로 갱신됩니다"
          />
        </div>
      )}

      {/*
        처음 설치할 때 할 일 — 전에는 홈 화면이 조항이 0건일 때만 띄웠다(P3-6 으로 이리 옮김).
        업무 담당자가 보는 홈보다 관리하는 사람이 보는 이 자리가 맞다. 조항이 이미
        있으면 접어 두고, 하나도 없으면 펼쳐서 바로 보이게 한다.
      */}
      {!error && (
        <details id="progress-setup" open={!hasClauses} className="mt-12 scroll-mt-8 border border-rule-soft">
          <summary className="cursor-pointer px-4 py-2.5 text-[12px] text-ink-2">
            처음 설치할 때 — 자료를 적재하는 명령{!hasClauses && ' (아직 적재된 안전기준 조항이 없습니다)'}
          </summary>
          <ol className="space-y-2 border-t border-rule-soft px-4 py-3 text-[13px] text-ink-2">
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
        </details>
      )}

      <PageToc items={TOC} />
    </>
  );
}
