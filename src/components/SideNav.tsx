'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useStage } from './StageContext';

/**
 * 좌측 업무흐름 레일 — 기본은 숨기고 ☰ 를 눌러야 연다 (2026-09-14)
 *
 * 전에는 항상 화면에 붙어 있었다(넓은 화면 sticky, 좁은 화면 상단 가로줄).
 * "좌·우 메뉴가 이중 내비게이션처럼 느껴진다"는 지적에 따라, 본문이 이 화면의
 * 주인공이 되도록 레일을 기본은 접어 두고 아이콘으로만 여는 방식으로 바꿨다
 * (와이어프레임 3a). 열림 상태는 저장하지 않는다 — "필요할 때만" 여는 것이
 * 목적이라 다시 들어와도 매번 접혀 있는 것이 맞다.
 *
 * 덮는(오버레이) 방식을 골랐다(3a) — 밀어내는 방식(3c)도 검토했지만, 이
 * 레일은 화면을 옮겨 다니는 용도라 열어 둔 채 작업을 계속하는 일이 잦지
 * 않다. 오버레이가 구조가 더 간단하고, 본문 폭을 건드리지 않는다.
 */
const AI_NOTE = 'AI가 관여하는 화면입니다 — 결과는 후보이고, 확정은 담당자가 합니다';

/*
  사람별 네 묶음 (05_02 P3-8, 2026-10-07)

  전에는 "업무 흐름 1·2·3(안전기준·사고·리콜) / 산출물 / 사전 / 시스템"처럼 자료
  종류로 나눴다. 그러자 KC기준 담당자의 진짜 일(조항 코드 검수)은 메뉴에 없고,
  정책담당자가 볼 화면은 「산출물」 한 줄에 묻혔다. 이제 "누가 무엇을 하러 오는가"로 나눈다.
*/
const GROUPS: Array<{
  title: string;
  items: Array<{ href: string; label: string; sub: string; ai?: boolean }>;
}> = [
  {
    title: '업무',
    items: [
      { href: '/accidents',        label: '사고조사',           sub: '원문 확인·조항 판정·병행 점검', ai: true },
      { href: '/recalls',          label: '리콜 분석',          sub: '1단계 국내 관련성 · 2단계 조항', ai: true },
      { href: '/standards/review', label: 'KC기준 · 코드 검수', sub: '조항에 붙은 위해요인 코드 확정', ai: true },
      { href: '/standards',        label: 'KC기준 · 원문',      sub: '들여온 기준과 조항' },
    ],
  },
  {
    title: '현황 · 인사이트',
    items: [
      { href: '/policy', label: '정책 현황판', sub: '위해 분포·불량/불법·사각지대 후보' },
    ],
  },
  {
    title: '참고',
    items: [
      { href: '/dictionary', label: '품목 판정 사전', sub: '검색어·품목→기준·서류 제품명', ai: true },
      { href: '/codebook',   label: '위해요인 코드',  sub: '코드 목록·원인 추정표' },
    ],
  },
  {
    title: '관리',
    items: [
      { href: '/admin', label: '관리 콘솔', sub: '상태·알림·자동 작업·AI 비용·진척', ai: true },
    ],
  },
];

const ALL_HREFS = GROUPS.flatMap((g) => g.items.map((i) => i.href));

/**
 * 지금 화면이 어느 항목에 속하는지 (2026-09-14, 담당자 지적: "보고 있는
 * 화면이 어디에 있는지 좌측 메뉴에서 표시하기")
 *
 * 그 항목의 주소로 시작하면 자기 하위 화면으로 본다 — `/accidents/confirm/…`도
 * "사고보고서" 항목이 맞다.
 *
 * `/analysis/[caseId]`(사건 상세)는 주소만으로는 못 맞힌다 — 사고인지
 * 리콜인지가 URL 에 안 드러나고, 그 사건 데이터는 그 라우트 안에서만
 * 조회된다. 그래서 그 라우트가 `StageContext`(`useStage()`)로 직접 알려
 * 주는 값을 `stage` 로 받아 우선 확인한다 — 라우트 밖(예: 목록 화면들)에서는
 * `stage` 가 null 이라 평소처럼 주소만으로 판단한다.
 */
function isActive(pathname: string, href: string, stage: string | null): boolean {
  if (stage != null) return stage === href;
  // `/standards/review` 에서는 `/standards` 가 아니라 더 긴 쪽만 켠다 — 가장 길게 맞는 항목 하나
  const matches = (h: string) => pathname === h || pathname.startsWith(`${h}/`);
  if (!matches(href)) return false;
  return !ALL_HREFS.some((h) => h.length > href.length && matches(h));
}

export function SideNav() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const stage = useStage();

  // 바깥을 누르거나 Esc 를 누르면 닫는다 — 오버레이가 열려 있는 채로 본문을
  // 다시 만지려면 일단 닫혀야 한다는 뜻이다(핸드오프 지시서 §3).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? '업무 흐름 메뉴 닫기' : '업무 흐름 메뉴 열기'}
        aria-expanded={open}
        className="fixed top-3 left-3 z-40 flex h-9 w-9 items-center justify-center border border-rule bg-surface text-[16px] leading-none shadow-sm hover:bg-measure-soft"
      >
        ☰
      </button>

      {/* 배경 스크림 — 열려 있는 동안 본문 클릭을 막고, 눌러서 닫을 수도 있다 */}
      {open && <div className="fixed inset-0 z-30 bg-ink/30" aria-hidden="true" />}

      <div
        ref={panelRef}
        className={`fixed inset-y-0 left-0 z-40 w-[16rem] overflow-y-auto border-r border-rule bg-surface shadow-lg transition-transform duration-150 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="border-b border-rule-soft px-5 py-5">
          <Link href="/" className="block" onClick={() => setOpen(false)}>
            <div className="label">국가기술표준원</div>
            <div className="mt-1 text-[15px] leading-tight font-semibold tracking-tight">
              KC안전기준
              <br />
              제품위해 분석
            </div>
          </Link>
        </div>

        <div className="px-2 py-4">
          {GROUPS.map((g) => (
            <div key={g.title} className="mt-3 border-t border-rule-soft pt-3 first:mt-0 first:border-t-0 first:pt-0">
              <div className="label px-3 pb-1">{g.title}</div>
              <ul>
                {g.items.map((a) => {
                  const active = isActive(pathname, a.href, stage);
                  return (
                    <li key={a.href}>
                      <Link
                        href={a.href}
                        onClick={() => setOpen(false)}
                        aria-current={active ? 'page' : undefined}
                        className={`group block rounded-sm border-l-2 px-3 py-2.5 transition-colors hover:bg-measure-soft ${
                          active ? 'border-measure bg-measure-soft' : 'border-transparent'
                        }`}
                      >
                        <span className={`block text-[13px] font-medium whitespace-nowrap group-hover:text-measure ${active ? 'text-measure' : ''}`}>
                          {a.label}
                          {a.ai && (
                            <span aria-label={AI_NOTE} title={AI_NOTE} className="ml-1">🤖</span>
                          )}
                        </span>
                        <span className="block text-[11px] whitespace-nowrap text-ink-3">{a.sub}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="mx-5 mb-5 border-t border-rule-soft pt-4">
          <p className="text-[11px] leading-relaxed text-ink-3">
            이 시스템은 위반 여부를 판정하지 않습니다. 관련될 수 있는 조항과 그 근거를
            제시하고, 확인 여부는 담당자가 정합니다.
          </p>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
            🤖 표시는 그 화면에서 AI가 관여한다는 뜻입니다. 어디에 어떤 모델을 쓰고 얼마가
            드는지는{' '}
            <Link href="/admin?tab=llm" onClick={() => setOpen(false)} className="underline decoration-rule underline-offset-2 hover:text-measure">
              AI 사용과 비용
            </Link>
            에 있습니다.
          </p>
        </div>
      </div>
    </>
  );
}
