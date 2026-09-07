'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 누른 자리에서 결과를 말해 주는 버튼
 *
 * 무엇이 잘못돼 있었나 (담당자 지적: "분석 실행이 안먹히네요. 그리고 화면이 깜빡입니다")
 *
 *   실제로는 잘 돌고 있었다. 문제는 알려 주는 방식이었다.
 *   1) 결과 문장을 주소줄(?done=)에 실어 되돌려 보내고 화면 맨 위에 띠로 그렸다.
 *      목록을 한참 내려간 상태에서 버튼을 누르면 그 띠가 보이지 않는다.
 *      특히 "적용할 기준을 못 찾아 분석하지 않았습니다" 처럼 아무 변화가 없는 경우,
 *      담당자에게는 버튼이 죽은 것과 똑같아 보인다.
 *   2) 주소가 바뀌면 화면 전체를 서버에서 다시 그린다. 이 화면들은 조회가 무거워서
 *      (현황 7종 + 목록) 그때마다 눈에 띄게 깜빡였다.
 *
 * 그래서 아예 주소를 바꾸지 않는다.
 *   결과 문장을 버튼 옆에 바로 붙이고, 숫자만 조용히 새로 읽는다(router.refresh).
 *   스크롤 위치가 그대로 유지되고 깜빡임도 없다.
 *
 * 누르는 동안 잠근다
 *   같은 일을 두 번 시키지 않기 위해서다. 돈이 드는 작업이면 돈도 두 번 나간다.
 */
export function ActionForm({
  action,
  hidden,
  label,
  pendingLabel,
  className = '',
  messageClassName = 'text-[11px] leading-snug text-ink-2',
  textInput,
  hotkeyRole,
}: {
  action: (prev: string | null, formData: FormData) => Promise<string>;
  hidden?: Record<string, string | number>;
  label: React.ReactNode;
  pendingLabel: string;
  className?: string;
  messageClassName?: string;
  /** 글을 적어 보내는 버튼일 때. 이름과 안내 문구를 준다 */
  textInput?: { name: string; placeholder: string };
  /** 검수 단축키(a·r)가 찾아 누를 버튼임을 표시한다. ReviewShortcuts 가 읽는다 */
  hotkeyRole?: 'approve' | 'reject';
}) {
  const [message, formAction, pending] = useActionState(action, null);
  const router = useRouter();

  // 작업이 끝나면 화면의 숫자를 새로 읽는다. 주소를 바꾸지 않으므로
  // 스크롤 위치도 펼쳐 둔 항목도 그대로 남는다.
  useEffect(() => {
    if (message) router.refresh();
  }, [message, router]);

  return (
    <span className={textInput ? 'block' : 'inline-flex flex-wrap items-center gap-2'}>
      <form action={formAction} className={textInput ? 'flex flex-wrap gap-2' : ''}>
        {hidden &&
          Object.entries(hidden).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={String(v)} />
          ))}
        {textInput && (
          <input
            type="text"
            name={textInput.name}
            required
            placeholder={textInput.placeholder}
            className="min-w-0 flex-1 border border-rule px-3 py-2 text-[13px]"
          />
        )}
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          data-review-action={hotkeyRole}
          className={`${className} ${pending ? 'cursor-wait opacity-60' : ''}`}
        >
          {pending ? pendingLabel : label}
        </button>
      </form>
      {message && (
        <span className={`${messageClassName} ${textInput ? 'mt-2 block' : ''}`}>{message}</span>
      )}
    </span>
  );
}
