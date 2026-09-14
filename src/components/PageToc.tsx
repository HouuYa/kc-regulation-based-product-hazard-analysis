'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

export interface TocItem {
  id: string;
  label: string;
  /**
   * 이 섹션이 속한 탭(Tabs.tsx 의 tab id). 탭 밖(공통) 섹션이면 생략한다.
   *
   * 탭 안 섹션은 다른 탭이 활성일 때 hidden 속성이 붙어 화면에서 사라진다 —
   * 그 상태에서 그냥 #id 로 점프하면 스크롤이 안 움직여 "고장 난 목차"처럼
   * 보인다(074, 담당자 지적). 먼저 그 탭으로 바꾼 뒤에 스크롤한다.
   */
  tab?: string;
  /**
   * 바로 위 항목의 하위 구역이면 true (2026-09-14, 담당자 지적)
   *
   * 한 구역이 성격이 다른 여러 하위 구역을 담고 있으면(예: 병행 점검 소견 —
   * 시험 공백·관련 리콜 등) 목차에서 상위 항목 하나로만 보여서 지금 스크롤이
   * 그 구역의 어디쯤인지 안 보인다는 지적을 받았다. 들여쓰기만 준 하위 항목을
   * 바로 아래에 추가해 목차가 실제 스크롤 위치와 더 자주 맞아떨어지게 한다.
   */
  indent?: boolean;
}

/**
 * 이 페이지 목차 — 기본은 숨기고 ≡ 아이콘으로 연다 (2026-09-14, 와이어프레임 3a)
 *
 * 전에는 넓은 화면에서 sticky 로 항상 붙어 있었고, 좁은 화면에서는 접힌
 * <details> 였다. "좌·우 메뉴가 이중 내비게이션처럼 보인다"는 지적에 따라
 * 화면 크기와 무관하게 오버레이 패널 하나로 통일한다 — 좌측 SideNav 와 같은
 * 규칙(기본 숨김·아이콘으로 열기·바깥 클릭이나 Esc 로 닫기·상태를 저장하지
 * 않음)을 오른쪽에도 그대로 적용한다.
 */
export function PageToc({ items, tabParam = 'tab' }: { items: TocItem[]; tabParam?: string }) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(items[0]?.id ?? '');
  const panelRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (items.length === 0) return;

    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter((heading): heading is HTMLElement => heading !== null);
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-12% 0px -72% 0px', threshold: 0 },
    );

    headings.forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [items]);

  // 바깥을 누르거나 Esc 를 누르면 닫는다 — SideNav 와 같은 규칙
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

  if (items.length === 0) return null;

  function goTo(item: TocItem) {
    const el = document.getElementById(item.id);
    const needsTabSwitch = item.tab && searchParams.get(tabParam) !== item.tab;

    setOpen(false);

    if (needsTabSwitch) {
      const params = new URLSearchParams(searchParams.toString());
      params.set(tabParam, item.tab!);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      // 탭 전환으로 hidden 속성이 풀리는 다음 페인트를 기다린 뒤 스크롤한다
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
      return;
    }

    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? '이 페이지 목차 닫기' : '이 페이지 목차 열기'}
        aria-expanded={open}
        className="fixed top-3 right-3 z-40 flex h-9 w-9 items-center justify-center border border-rule bg-surface text-[16px] leading-none shadow-sm hover:bg-measure-soft"
      >
        ≡
      </button>

      {open && <div className="fixed inset-0 z-30 bg-ink/30" aria-hidden="true" />}

      <div
        ref={panelRef}
        aria-label="현재 페이지 목차"
        className={`fixed inset-y-0 right-0 z-40 w-64 overflow-y-auto border-l border-rule bg-surface px-4 py-5 shadow-lg transition-transform duration-150 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="label">이 페이지</div>
        <TocLinks items={items} activeId={activeId} onGoTo={goTo} />
      </div>
    </>
  );
}

function TocLinks({
  items, activeId, onGoTo,
}: { items: TocItem[]; activeId: string; onGoTo: (item: TocItem) => void }) {
  return (
    <nav className="mt-2" aria-label="섹션 바로가기">
      <ul className="space-y-1 border-l border-rule-soft pl-3">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              onClick={(e) => { e.preventDefault(); onGoTo(item); }}
              className={`block py-1 text-[11px] leading-snug transition-colors hover:text-measure ${
                item.indent ? 'pl-3' : ''
              } ${
                activeId === item.id ? 'border-l-2 border-measure -ml-[14px] pl-3 text-measure' : 'text-ink-3'
              }`}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
      <a href="#top" className="mt-4 inline-block text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink">
        맨 위로
      </a>
    </nav>
  );
}
