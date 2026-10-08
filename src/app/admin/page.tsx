import Link from 'next/link';
import { PageHead, TermsNote, type FlowStep } from '@/components/Panel';
import { StatusTab } from './StatusTab';
import { JobsTab } from './JobsTab';
import { LlmTab } from './LlmTab';
import { ProgressTab } from './ProgressTab';

export const dynamic = 'force-dynamic';

/**
 * 관리 — 담당자가 시스템을 관리하는 자리 (P3-6)
 *
 * 옛 운영(/ops)과 🤖 AI 사용(/llm) 두 화면을 하나로 합쳤다. 두 화면 모두
 * "업무 흐름 위"가 아니라 "흐름이 제대로 도는가"를 보는 자리인데, 따로 있으니
 * AI 사용 요약이 운영 화면에도 한 번 더 들어가 같은 숫자가 두 군데 떠 있었다.
 *
 * 탭은 주소(?tab=)로 고른다 — 이 저장소는 같은 URL 안에서 탭으로 가리기보다
 * 주소 자체로 화면을 구분하는 쪽을 택했다(docs/화면_구조_개편_탭에서_URL_분리_2026-09-14.md).
 * 덕분에 고른 탭의 조회만 돈다. 무거운 운영 조회가 AI 사용 탭을 열 때마다 함께
 * 돌지 않는다.
 */

type TabId = 'status' | 'jobs' | 'llm' | 'progress';

interface TabInfo {
  label: string;
  title: string;
  lead: string;
  workflow?: FlowStep[];
}

const TABS: Record<TabId, TabInfo> = {
  status: {
    label: '상태·알림',
    title: '시스템이 지금 제대로 돌고 있는가',
    lead: '자동 작업 상태와 확인할 문제를 보여 줍니다. 문제가 없으면 조치할 일이 없습니다.',
    /*
      이 화면은 업무 흐름 위에 있지 않다 — 흐름이 지금 돌고 있는지 보는 자리다.
      그래서 순서도도 「감시 → 발견 → 알림 → 손보기」의 순서로 그린다.
    */
    workflow: [
      { label: '자동으로 돎', href: '/admin?tab=jobs#ops-details', note: '데이터베이스 안에서', state: 'done' },
      { label: '문제 찾기', href: '#ops-attention', note: '5분마다', state: 'done' },
      { label: '알림', href: '#ops-alerts', note: '텔레그램', state: 'done' },
      { label: '손보기', who: '사람', href: '/admin?tab=jobs#ops-actions', state: 'here' },
    ],
  },
  jobs: {
    label: '자동 작업',
    title: '무엇이 스스로 돌고 있고, 무엇을 앞당길 수 있나',
    lead: '데이터베이스 안에서 스스로 도는 작업과 그 진행 상황입니다. 기다리지 않고 지금 돌리거나, 비용이 드는 작업을 켜고 끄는 자리이기도 합니다.',
  },
  llm: {
    label: 'AI 사용과 비용',
    title: '어디에 어떤 모델을 쓰고, 얼마가 드는가',
    lead: '이 시스템은 정해진 자리에서만 AI를 부릅니다. 어느 조항이 걸리는지는 SQL이 계산하고, AI는 뜻을 옮기거나 후보를 걸러내는 일만 합니다. 그 자리와 비용을 여기서 봅니다.',
    workflow: [
      { label: 'AI를 부름', href: '#llm-sites', note: '정해진 자리에서만', state: 'done' },
      { label: '호출을 기록', note: '토큰·비용·근거', state: 'done' },
      { label: '비용으로 환산', href: '#llm-cost', note: '단가표로', state: 'done' },
      { label: '비싼 자리 손보기', who: '사람', href: '#llm-daily', state: 'here' },
    ],
  },
  progress: {
    label: '진척 현황',
    title: '사고보고서와 리콜이 어디까지 처리됐나',
    lead: '올린 사고보고서와 들어온 리콜이 원문 확인·코드·의미 검색 준비·분석·채택의 어느 걸음까지 왔는지 숫자로 봅니다. 읽기 전용입니다 — 처리는 사고보고서·리콜 화면에서 합니다.',
  },
};

const TAB_ORDER: TabId[] = ['status', 'jobs', 'llm', 'progress'];

/** 기본 탭(상태·알림)은 ?tab= 없이 둔다 — 옛 /ops 주소가 그대로 이 자리로 온다 */
function tabHref(id: TabId): string {
  return id === 'status' ? '/admin' : `/admin?tab=${id}`;
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab: raw } = await searchParams;
  // 주소줄에서 오는 값이므로 목록 안에서만 고른다. 모르는 값이면 기본 탭
  const tab: TabId = TAB_ORDER.includes(raw as TabId) ? (raw as TabId) : 'status';
  const info = TABS[tab];

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead label={`관리 · ${info.label}`} title={info.title} lead={info.lead} workflow={info.workflow} />

      {/*
        ScreenSwitch 와 같은 모양이지만 그쪽은 경로(pathname)만 비교한다 — 여기는
        같은 경로에서 ?tab= 만 바뀌므로 지금 탭을 서버에서 정해 그린다.
      */}
      <div className="mt-5 flex flex-wrap gap-2" role="navigation" aria-label="관리 화면 탭">
        {TAB_ORDER.map((id) => {
          const active = id === tab;
          return (
            <Link
              key={id}
              href={tabHref(id)}
              aria-current={active ? 'page' : undefined}
              className={`border px-4 py-2 text-[13px] font-medium ${
                active
                  ? 'border-measure bg-measure text-white'
                  : 'border-rule text-ink-2 hover:bg-measure-soft'
              }`}
            >
              {TABS[id].label}
            </Link>
          );
        })}
      </div>

      {tab === 'status' && <StatusTab />}
      {tab === 'jobs' && <JobsTab />}
      {tab === 'llm' && <LlmTab />}
      {tab === 'progress' && <ProgressTab />}

      <TermsNote />
    </div>
  );
}
