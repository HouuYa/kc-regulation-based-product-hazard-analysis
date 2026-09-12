'use client';

import { useEffect, useState } from 'react';
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
}

export function PageToc({ items, tabParam = 'tab' }: { items: TocItem[]; tabParam?: string }) {
  const [activeId, setActiveId] = useState(items[0]?.id ?? '');
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

  if (items.length === 0) return null;

  function goTo(item: TocItem) {
    const el = document.getElementById(item.id);
    const needsTabSwitch = item.tab && searchParams.get(tabParam) !== item.tab;

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
    <aside className="page-toc" aria-label="현재 페이지 목차">
      <details className="page-toc-mobile">
        <summary>현재 페이지 목차</summary>
        <TocLinks items={items} activeId={activeId} onGoTo={goTo} />
      </details>
      <div className="page-toc-desktop">
        <div className="label">이 페이지</div>
        <TocLinks items={items} activeId={activeId} onGoTo={goTo} />
      </div>
    </aside>
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
