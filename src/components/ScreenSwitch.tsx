'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * 검토/인사이트, 현황/처리할 것처럼 성격이 다른 두 화면을 오가는 링크 한 쌍
 * (2026-09-14, 와이어프레임 1a)
 *
 * 탭이 아니라 페이지 링크다 — 담당자가 "지금 결정할 화면"과 "참고만 하는
 * 화면"을 주소 자체로 구분해 이동한다(같은 URL 안에서 탭으로 가리던 이전
 * 방식은 073, 그 설계 근거는 docs/화면_구조_개편_검토_인사이트_분리_2026-09-12.md).
 * `analysis/[caseId]`·`accidents`·`recalls` 세 화면이 이 컴포넌트를 함께 쓴다.
 *
 * 지금 위치는 클라이언트에서 직접 읽는다 (2026-09-14 수정, 담당자 지적:
 * "검토화면을 클릭했는지 인사이트 화면을 클릭했는지 구분이 안 됨")
 *   전에는 부르는 쪽이 `current` prop으로 지금 화면 주소를 넘겨줬다. 그런데
 *   `analysis/[caseId]/layout.tsx`는 검토·인사이트 두 페이지가 함께 쓰는
 *   서버 컴포넌트라, 자신이 지금 어느 쪽을 감싸고 있는지 알 방법이 없어
 *   `current`를 검토 쪽 주소로 고정해 버렸다 — 그래서 인사이트 화면에 있어도
 *   항상 "검토 화면"만 채워진 상자로 보였다. `usePathname()`으로 실제 주소를
 *   직접 읽으면 이 문제 자체가 생길 수 없다.
 */
export function ScreenSwitch({
  options,
}: { options: Array<{ href: string; label: string }> }) {
  const pathname = usePathname();

  return (
    <div className="mt-5 flex flex-wrap gap-2" role="navigation" aria-label="화면 전환">
      {options.map((o) => {
        const active = o.href === pathname;
        return (
          <Link
            key={o.href}
            href={o.href}
            aria-current={active ? 'page' : undefined}
            className={`border px-4 py-2 text-[13px] font-medium ${
              active
                ? 'border-measure bg-measure text-white'
                : 'border-rule text-ink-2 hover:bg-measure-soft'
            }`}
          >
            {o.label}{!active && ' →'}
          </Link>
        );
      })}
    </div>
  );
}
