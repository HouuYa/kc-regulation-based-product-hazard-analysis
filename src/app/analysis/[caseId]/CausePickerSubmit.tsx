'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 「고른 원인으로 시험항목 찾기」 처리중 표시 (2026-09-14)
 *
 * 이 버튼은 서버 액션이 아니라 GET 폼 제출이다 — 고른 원인을 주소줄(?cause=…)에
 * 실어야 같은 화면을 다시 열거나 남에게 보내도 그대로 나온다(CausePicker 주석).
 * 그래서 다른 버튼들과 달리 ActionForm(useActionState 기반)을 그대로 못 쓴다 —
 * ActionForm 은 서버 액션이 문장을 돌려주는 모양을 전제한다.
 *
 * 대신 같은 목적(눌렀다는 것을 알리고, 끝날 때까지 다시 못 누르게 잠그기)을
 * useTransition 으로 낸다. 폼의 기본 GET 제출(전체 새로고침)을 막고, 같은 값을
 * router.push 로 옮겨 클라이언트 전환만 일으킨다 — 결과 주소는 완전히 같다.
 */
export function CausePickerSubmit({ caseId, className }: { caseId: number; className: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`${className} ${pending ? 'cursor-wait opacity-60' : ''}`}
      onClick={(e) => {
        e.preventDefault();
        const form = e.currentTarget.form;
        if (!form) return;
        const params = new URLSearchParams();
        for (const [k, v] of new FormData(form).entries()) {
          if (typeof v === 'string') params.append(k, v);
        }
        startTransition(() => {
          router.push(`/analysis/${caseId}?${params.toString()}`);
        });
      }}
    >
      {pending ? '찾는 중…' : '고른 원인으로 시험항목 찾기'}
    </button>
  );
}
