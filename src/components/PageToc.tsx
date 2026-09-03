'use client';

import { useEffect, useState } from 'react';

export interface TocItem {
  id: string;
  label: string;
}

export function PageToc({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = useState(items[0]?.id ?? '');

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

  return (
    <aside className="page-toc" aria-label="현재 페이지 목차">
      <details className="page-toc-mobile">
        <summary>현재 페이지 목차</summary>
        <TocLinks items={items} activeId={activeId} />
      </details>
      <div className="page-toc-desktop">
        <div className="label">이 페이지</div>
        <TocLinks items={items} activeId={activeId} />
      </div>
    </aside>
  );
}

function TocLinks({ items, activeId }: { items: TocItem[]; activeId: string }) {
  return (
    <nav className="mt-2" aria-label="섹션 바로가기">
      <ul className="space-y-1 border-l border-rule-soft pl-3">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
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