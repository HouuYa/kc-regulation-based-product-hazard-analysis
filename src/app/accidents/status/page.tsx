import { PageHead, ConnectionError, TermsNote } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { AutoRefresh } from '@/components/AutoRefresh';
import { PageToc, type TocItem } from '@/components/PageToc';
import { ScreenSwitch } from '@/components/ScreenSwitch';
import type { BoardParams } from '@/components/Board';
import { load, UPLOAD_STEPS } from '../data';

export const dynamic = 'force-dynamic';

const ACCIDENTS_STATUS_TOC: TocItem[] = [
  { id: 'accidents-status', label: '처리 현황' },
];

/**
 * 사고보고서 — 현황 (2026-09-14, 와이어프레임 1a)
 *
 * `/accidents`(처리할 것)에서 갈라져 나온 읽기 전용 화면 — 집계 숫자와
 * "올린 뒤 무슨 일이 일어나는지" 설명만 있다. 결정 버튼은 하나도 없다.
 * 조회·상수는 `../data.ts` 에서 그대로 가져다 쓴다 — 목록까지 함께 불러오지만
 * (load 가 요약과 목록을 한 번에 조회하도록 짜여 있다, §4.1) 이 화면은 요약만
 * 그린다.
 */
export default async function AccidentsStatusPage({
  searchParams,
}: {
  searchParams: Promise<BoardParams>;
}) {
  const params = await searchParams;

  let data: Awaited<ReturnType<typeof load>> | null = null;
  let error: string | null = null;
  try {
    data = await load(params);
  } catch (e) {
    console.error('사고보고서 현황 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="2 · 사고보고서"
        title="사고보고서와 안전기준 연계 분석"
        lead="PDF를 올리고 원문을 확인하면, 사고와 관련될 수 있는 안전기준 조항을 찾습니다."
        workflow={data ? [
          { label: '올리기', who: '사람', href: '/accidents#accidents-upload', note: `${data.summary.files}건`, state: 'done' },
          {
            label: '글자·개인정보 검사',
            note: data.summary.fileErrors > 0 ? `막힘 ${data.summary.fileErrors}` : '이상 없음',
            state: data.summary.fileErrors > 0 ? 'here' : 'done',
          },
          {
            label: '원문 확인',
            who: '사람',
            note: `${data.summary.confirmed} / ${data.summary.cases}`,
            state: data.summary.confirmed < data.summary.cases ? 'here' : 'done',
          },
          {
            label: '코드·검색 준비',
            note: `${data.summary.embedded} / ${data.summary.cases}`,
            state: data.summary.embedded < data.summary.cases ? 'here' : 'done',
          },
          {
            label: '분석',
            who: '사람',
            note: `${data.summary.analyzed} / ${data.summary.confirmed}`,
            state: data.summary.analyzed < data.summary.confirmed ? 'here' : 'done',
          },
          {
            label: '검수·채택',
            who: '사람',
            href: '/accidents#accidents-list',
            note: `채택 ${data.summary.adopted}`,
            state: 'todo',
          },
        ] : undefined}
      />

      <ScreenSwitch
        options={[
          { href: '/accidents', label: '처리할 것' },
          { href: '/accidents/status', label: '현황' },
        ]}
      />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          <div id="accidents-status" className="mt-8 scroll-mt-8">
            <StatusBar
              items={[
                { label: '올린 문서', value: data.summary.files, note: '사고조사보고서 PDF' },
                {
                  label: '추출 오류', value: data.summary.fileErrors, wantsZero: true,
                  note: '글자가 없는 스캔본이거나 개인정보가 들어 있는 문서입니다. 분석까지 가지 않습니다',
                },
                {
                  label: '원문 확인함', value: data.summary.confirmed, of: data.summary.cases,
                  note: '뽑아낸 글자를 담당자가 직접 확인한 문서입니다. 확인해야 분석할 수 있습니다',
                },
                {
                  label: '위해요인 코드', value: data.summary.coded, of: data.summary.cases,
                  note: '원인(HF)과 피해유형(DT) 코드가 붙은 사고',
                },
                {
                  label: '의미 검색 준비', value: data.summary.embedded, of: data.summary.cases,
                  note: '단어가 달라도 뜻이 비슷한 조항까지 찾아냅니다. 새로 들어온 자료는 저절로 준비됩니다',
                },
                {
                  label: '분석 실행됨', value: data.summary.analyzed, of: data.summary.cases,
                  note: '관련될 수 있는 조항을 찾아 순위까지 매긴 사고',
                },
                {
                  label: '채택된 조항', value: data.summary.adopted,
                  note: '담당자가 "관련 있다"고 확인한 조항입니다. 이 기록으로 정확도를 잽니다',
                },
              ]}
            />
          </div>

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

          {/* 준비가 밀려 있으면 숫자가 계속 바뀐다 — 새로고침을 사람이 누르지 않게 한다 */}
          <div className="mt-4">
            <AutoRefresh
              active={data.summary.embedded < data.summary.cases}
              seconds={20}
              label="의미 검색 준비가 진행 중입니다 — 숫자가 저절로 갱신됩니다"
            />
          </div>
        </>
      )}

      <TermsNote />
      <PageToc items={ACCIDENTS_STATUS_TOC} />
    </div>
  );
}
