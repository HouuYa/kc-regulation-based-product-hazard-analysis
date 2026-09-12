'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * 검토용 / 인사이트용(또는 처리할 것 / 현황) 탭 (073)
 *
 * 서버에서 두 탭의 내용을 전부 미리 그려 children 으로 받는다 — 탭을 눌러도
 * 데이터를 다시 안 불러온다. 이미 화면에 있는 것을 가리고 보이기만 한다.
 *
 * 상태를 주소줄에 싣는 이유
 *   기존 검색·정렬·필터(BoardToolbar 등)도 전부 주소줄에 있다. 탭만 컴포넌트
 *   내부 상태로 두면 "이 조건으로 찾은 걸 링크로 보내니 탭이 딴 데 가 있더라"가
 *   생긴다. 같은 원칙을 탭에도 적용한다.
 */
export interface TabDef {
  id: string;
  label: string;
}

export function Tabs({
  tabs, defaultTab, paramName = 'tab', children,
}: {
  tabs: TabDef[];
  defaultTab: string;
  paramName?: string;
  children: ReactNode[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = searchParams.get(paramName) ?? defaultTab;

  const setActive = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(paramName, id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div>
      <div role="tablist" className="mt-6 flex gap-1 border-b border-rule">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => setActive(t.id)}
            className={`border-b-2 px-4 py-2 text-[13px] font-medium transition-colors ${
              active === t.id
                ? 'border-measure text-measure'
                : 'border-transparent text-ink-3 hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div key={t.id} hidden={active !== t.id}>
          {children[i]}
        </div>
      ))}
    </div>
  );
}
