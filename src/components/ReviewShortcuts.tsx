'use client';

import { useEffect } from 'react';

/**
 * 검수 화면 키보드 단축키 — 판단은 그대로 사람이, 손만 덜 움직인다
 *
 * 왜 만드는가
 *   검수 대기가 검색어 4,943개, 법정 품목 대응 502건이다. 판단 자체는 줄일 수
 *   없지만(줄이면 이 체계의 안전장치가 무너진다), 버튼을 눈으로 찾아 마우스를
 *   가져가 누르는 시간은 줄일 수 있다. 한 건에 2초씩만 줄여도 5,400건이면
 *   3시간이다.
 *
 * 일괄 승인을 만들지 않은 이유
 *   법정 품목 → 기준 대응은 틀리면 그 품목으로 이어지는 **모든** 사고·리콜에
 *   엉뚱한 기준의 시험이 근거로 제시된다(actions.ts reviewLink 주석). 한 번에
 *   여러 건을 넘기는 장치는 이 무게에 맞지 않는다. 그래서 여기서 줄이는 것은
 *   오직 손동작뿐이고, 한 건에 한 번의 판단은 그대로 남긴다.
 *
 *   검색어 쪽은 이미 품목 단위 일괄(reviewTarget, "AI 제안 N개 모두 확정")이
 *   있어 그것을 쓰면 된다. 여기서 다시 만들지 않는다.
 *
 *   j · ↓   다음 행       k · ↑   이전 행
 *   a       확정          r       반려
 */
export function ReviewShortcuts() {
  useEffect(() => {
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-review-row]'));

    /* 지금 보고 있는 행. 포커스가 곧 표시이므로 globals.css 의 :focus-visible 이 테두리를 그린다 */
    let idx = -1;

    const focusAt = (i: number) => {
      const list = rows();
      if (list.length === 0) return;
      idx = Math.max(0, Math.min(i, list.length - 1));
      list[idx].focus();
      list[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    };

    /*
      확정·반려하면 그 행은 목록에서 빠지고 화면이 새로 그려진다
      (ActionForm 이 주소를 바꾸지 않고 router.refresh 로 다시 읽는다).
      사라진 행에 있던 포커스는 풀리므로 같은 자리 — 이제 다음 행이 와 있는
      자리 — 로 포커스를 돌려준다. 그러지 않으면 한 건 처리할 때마다 마우스로
      되돌아가야 해서 단축키를 만든 뜻이 없어진다.
    */
    const refocusAfterRefresh = () => {
      const keep = idx;
      const parent = rows()[0]?.parentElement;
      if (!parent) return;

      const done = () => {
        observer.disconnect();
        clearTimeout(fallback);
        focusAt(keep);
      };
      const observer = new MutationObserver(done);
      observer.observe(parent, { childList: true });
      // 목록이 그대로일 수도 있다(이미 같은 상태였던 경우). 그때도 포커스는 돌려준다
      const fallback = setTimeout(done, 1500);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // 검색창에 글을 적는 중이면 단축키를 끈다 — "r" 을 못 적으면 곤란하다
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // 마우스로 다른 행을 눌러 옮겨 갔을 수 있다. 실제 포커스를 기준으로 맞춘다
      const focused = target?.closest?.('[data-review-row]') as HTMLElement | null;
      if (focused) idx = rows().indexOf(focused);

      const key = event.key.toLowerCase();

      if (key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); focusAt(idx + 1); return; }
      if (key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); focusAt(idx - 1); return; }
      if (key !== 'a' && key !== 'r') return;

      const row = rows()[idx];
      if (!row) return;
      const button = row.querySelector<HTMLButtonElement>(
        `[data-review-action="${key === 'a' ? 'approve' : 'reject'}"]`,
      );
      if (!button || button.disabled) return;

      event.preventDefault();
      button.click();
      refocusAfterRefresh();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return null;
}
