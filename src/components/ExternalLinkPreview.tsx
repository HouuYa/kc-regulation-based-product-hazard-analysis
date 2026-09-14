'use client';

import { useEffect, useState } from 'react';

/**
 * 외부 사이트를 새 탭 대신 화면 안 창(모달)으로 띄운다 (074, 담당자 요청)
 *
 * "검토를 용이하고 쉽게 닫을 수 있도록" — 새 탭으로 나가면 원래 화면으로 돌아오는
 * 것 자체가 한 동작이다. 화면 안에서 열고 Esc·바깥 클릭·닫기 버튼 아무거나로
 * 바로 닫히게 한다.
 *
 * 한계 — 모든 사이트가 창 안에서 열리지는 않는다. 정부·기관 사이트 다수가
 * iframe 삽입을 막아 둔다(X-Frame-Options 등). 그 경우 안이 빈 채로 남는데,
 * 이걸 코드가 미리 알아낼 방법이 없다(교차 출처라 스크립트로 감지 불가) — 그래서
 * "새 탭에서 열기"를 항상 같이 보여준다. 안이 비어 보이면 그걸 누르면 된다.
 *
 * 내부 화면 미리보기로도 쓴다 (`internal`, 2026-09-14, 담당자 요청)
 *   "관련 리콜을 클릭했을 때 원본보기처럼 창을 내부에 띄워 병행으로 검토하고
 *   싶다" — 지금 사건을 검토하면서 참조하는 다른 사건(예: 유사 리콜)을 화면
 *   전환 없이 같이 보는 용도다. 우리 서버의 페이지라 iframe 삽입이 막힐 일이
 *   없으므로(같은 출처) `internal` 이면 그 안내 문구를 뺀다.
 */
export function ExternalLinkPreview({
  href, label, className, internal,
}: { href: string; label: string; className?: string; internal?: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {label}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex h-[85vh] w-full max-w-4xl flex-col border border-rule bg-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-rule bg-paper px-3 py-2">
              <span className="addr truncate text-[11px] text-ink-3">{href}</span>
              <div className="flex shrink-0 items-center gap-3">
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-[11px] text-measure underline underline-offset-2"
                >
                  새 탭에서 열기
                </a>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="border border-rule px-2 py-0.5 text-[11px] text-ink-2 hover:bg-paper-2"
                >
                  닫기 ✕
                </button>
              </div>
            </div>
            {!internal && (
              <p className="border-b border-rule-soft bg-paper px-3 py-1 text-[11px] text-ink-3">
                안이 비어 보이면 이 사이트가 창 안 표시를 막아 둔 것입니다 — &ldquo;새 탭에서 열기&rdquo;를 눌러 주세요.
              </p>
            )}
            <iframe src={href} title={label} className="w-full flex-1 bg-surface" />
          </div>
        </div>
      )}
    </>
  );
}
