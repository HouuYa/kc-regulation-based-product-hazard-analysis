'use client';

import { useFormStatus } from 'react-dom';

/**
 * 누르면 "하는 중"이라고 말하는 버튼
 *
 * 담당자 요청: "분석 실행 버튼을 눌렀을 때, 처리 중일 경우 처리 중으로 메시지 보이기"
 *
 * 왜 필요한가
 *   분석은 몇 초, 리콜 수집은 수십 초가 걸린다. 그동안 화면이 아무 말도 하지 않으면
 *   눌린 건지 아닌지 알 수 없어 또 누르게 된다. 같은 일을 두 번 시키는 셈이고,
 *   돈이 드는 작업이라면 돈도 두 번 나간다.
 *
 * 이 프로젝트에서 유일한 클라이언트 컴포넌트다
 *   다른 화면은 전부 서버에서 그려 보낸다. 그런데 "지금 보내는 중"은 서버가 알 수
 *   없는 상태다 — 브라우저 안에서만 일어나는 일이기 때문이다. 그래서 이 버튼만
 *   예외로 둔다. 폼이 제출 중인지는 React 가 알려 준다(useFormStatus).
 *
 * 누르는 동안 잠근다
 *   disabled 로 두 번 눌리는 것을 막는다. 되돌리기 어려운 작업일수록 중요하다.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className = '',
}: {
  children: React.ReactNode;
  /** 누른 뒤 보일 말. 예: "분석하는 중…" */
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`${className} ${pending ? 'cursor-wait opacity-60' : ''}`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
