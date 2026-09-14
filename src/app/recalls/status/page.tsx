import { PageHead, ConnectionError, TermsNote } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { AutoRefresh } from '@/components/AutoRefresh';
import { PageToc, type TocItem } from '@/components/PageToc';
import { ScreenSwitch } from '@/components/ScreenSwitch';
import type { BoardParams } from '@/components/Board';
import { load } from '../data';

export const dynamic = 'force-dynamic';

const RECALLS_STATUS_TOC: TocItem[] = [
  { id: 'recalls-status', label: '처리 현황' },
];

/**
 * 리콜 — 현황 (2026-09-14, 와이어프레임 1a)
 *
 * `/recalls`(처리할 것)에서 갈라져 나온 읽기 전용 화면 — 집계 숫자만 있다.
 * 조회는 `../data.ts` 에서 그대로 가져다 쓴다.
 */
export default async function RecallsStatusPage({
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
    console.error('리콜 현황 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="3 · 리콜"
        title="리콜과 안전기준 연계 분석"
        lead="리콜 자료를 확인하고 국내 유통 여부를 기록한 뒤, 관련될 수 있는 안전기준을 찾습니다."
        workflow={data ? [
          {
            label: '리콜 수집',
            note: `${(data.summary.overseas + data.summary.domestic).toLocaleString()}건`,
            state: 'done',
          },
          {
            label: '위해요인 코드',
            note: `${data.summary.coded.toLocaleString()} / ${data.summary.cases.toLocaleString()}`,
            state: data.summary.coded < data.summary.cases ? 'here' : 'done',
          },
          {
            label: '뜻 검색 준비',
            note: `${data.summary.embedded.toLocaleString()} / ${data.summary.cases.toLocaleString()}`,
            state: data.summary.embedded < data.summary.cases ? 'here' : 'done',
          },
          {
            label: '분석',
            who: '사람',
            note: `${data.summary.analyzed.toLocaleString()} / ${data.summary.cases.toLocaleString()}`,
            state: 'here',
          },
          {
            label: '국내 유통 확인',
            who: '사람',
            href: '/recalls#recalls-list',
            note: `미확인 ${data.summary.uncheckedDistribution.toLocaleString()}`,
            state: 'todo',
          },
        ] : undefined}
      />

      <ScreenSwitch
        options={[
          { href: '/recalls', label: '처리할 것' },
          { href: '/recalls/status', label: '현황' },
        ]}
      />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          <div id="recalls-status" className="mt-8 scroll-mt-8">
            <StatusBar
              items={[
                { label: '해외 리콜', value: data.summary.overseas, note: '협회 담당자가 승인한 것만 가져옵니다' },
                { label: '국내 리콜', value: data.summary.domestic, note: '국내에서 공고된 리콜' },
                {
                  label: '국내 유통 확인 대기', value: data.summary.uncheckedDistribution, wantsZero: true,
                  note: '해외에서 리콜된 제품이 국내에도 풀렸는지는 담당자가 직접 확인해야 합니다. 이걸 알아야 보고 의무가 있는지 따질 수 있습니다',
                },
                {
                  label: '의미 검색 준비', value: data.summary.embedded, of: data.summary.cases,
                  note: '단어가 달라도 뜻이 비슷한 조항까지 찾아냅니다. 새로 들어온 자료는 저절로 준비됩니다',
                },
                {
                  label: '분석 실행됨', value: data.summary.analyzed, of: data.summary.cases,
                  note: '관련될 수 있는 조항을 찾아 순위까지 매긴 리콜',
                },
                {
                  // 담당자 요청으로 맨 뒤로 옮겼다 — 앞줄 끝에 혼자 남아 아랫줄이
                  // 비어 보이던 자리를 메운다
                  label: '위해요인 코드', value: data.summary.coded, of: data.summary.cases,
                  note: '원인(HF)과 피해유형(DT) 코드가 붙은 리콜',
                },
              ]}
            />
          </div>

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
      <PageToc items={RECALLS_STATUS_TOC} />
    </div>
  );
}
