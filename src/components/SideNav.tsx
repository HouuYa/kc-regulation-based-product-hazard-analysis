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

const STAGES = [
  { no: '1', href: '/standards', label: '안전기준',   sub: '조항·시험 적재',   ai: true },
  { no: '2', href: '/accidents', label: '사고보고서', sub: '등록·현황·분석',   ai: true },
  { no: '3', href: '/recalls',   label: '리콜',       sub: '수집·현황·분석',   ai: true },
];

const GROUPS: Array<{
  title: string;
  items: Array<{ href: string; label: string; sub: string; ai?: boolean }>;
}> = [
  {
    title: '산출물',
    items: [
      { href: '/insights', label: 'KC안전기준 개선 요인', sub: '사각지대·국내외 대조·시험항목' },
    ],
  },
  {
    title: '사전 · 참고',
    items: [
      { href: '/keywords', label: '품목 검색어 사전', sub: '일상어 → 법정 품목', ai: true },
      { href: '/terms',    label: '품목 용어 사전',   sub: '품목 → 적용기준',    ai: true },
      { href: '/codebook', label: '위해요인 코드',    sub: '참고 문서' },
    ],
  },
  {
    title: '시스템',
    items: [
      { href: '/llm', label: 'AI 사용과 비용', sub: '자리·모델·단가', ai: true },
      { href: '/ops', label: '운영',           sub: '상태·알림·접속 관리' },
    ],
  },
];

/**
 * 지금 화면이 어느 항목에 속하는지 (2026-09-14, 담당자 지적: "보고 있는
 * 화면이 어디에 있는지 좌측 메뉴에서 표시하기")
 *
 * 그 항목의 주소로 시작하면 자기 하위 화면으로 본다 — `/accidents/status`도
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
  return pathname === href || pathname.startsWith(`${href}/`);
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
          <div className="label px-3 pb-1">업무 흐름</div>
          <ol>
            {STAGES.map((s) => {
              const active = isActive(pathname, s.href, stage);
              return (
                <li key={s.href}>
                  <Link
                    href={s.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={`group flex items-baseline gap-3 rounded-sm border-l-2 px-3 py-2.5 transition-colors hover:bg-measure-soft ${
                      active ? 'border-measure bg-measure-soft' : 'border-transparent'
                    }`}
                  >
                    <span className={`addr text-[11px] group-hover:text-measure ${active ? 'text-measure' : 'text-ink-3'}`}>
                      {s.no}
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-[13px] font-medium whitespace-nowrap ${active ? 'text-measure' : ''}`}>
                        {s.label}
                        {s.ai && (
                          <span aria-label={AI_NOTE} title={AI_NOTE} className="ml-1">🤖</span>
                        )}
                      </span>
                      <span className="block text-[11px] whitespace-nowrap text-ink-3">{s.sub}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>

          {GROUPS.map((g) => (
            <div key={g.title} className="mt-3 border-t border-rule-soft pt-3">
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
            <Link href="/llm" onClick={() => setOpen(false)} className="underline decoration-rule underline-offset-2 hover:text-measure">
              AI 사용과 비용
            </Link>
            에 있습니다.
          </p>
        </div>
      </div>
    </>
  );
}
