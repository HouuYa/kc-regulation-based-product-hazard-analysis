'use client';

import { useActionState, useEffect, useState } from 'react';
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
 *
 * 여러 버튼을 한 폼에 두는 경우 (`buttons`, 2026-09-14)
 *   채택/반려, 어린이제품 여부(4지선다)처럼 값만 다른 버튼 여럿이 hidden 값이나
 *   반려 사유 select 같은 같은 부가 입력을 나눠 쓰는 자리가 있다. 폼을 여러 개로
 *   쪼개면 그 부가 입력도 폼마다 따로 둬야 해서 화면이 지저분해진다. `buttons` 를
 *   주면 한 폼 안에 여러 제출 버튼을 두고, 그중 실제로 누른 버튼만 처리 중 문구로
 *   바뀐다(나머지는 비활성화만 된다 — 다른 버튼이 처리되는 동안 또 누르면 안 되니까).
 *
 * 부가 입력 (`children`)
 *   반려 사유 select, 파일 입력, 별도 텍스트 입력처럼 `textInput` 하나로는 감당 못
 *   하는 자리에 쓴다. 버튼(들) 앞에 그대로 끼워 넣는다.
 */
export interface ActionFormButton {
  /** 이 버튼을 눌렀을 때 formData 에 실릴 값 (name 은 `buttonField`) */
  value: string;
  label: React.ReactNode;
  pendingLabel: string;
  className?: string;
  /** 검수 단축키(a·r)가 찾아 누를 버튼임을 표시한다. ReviewShortcuts 가 읽는다 */
  hotkeyRole?: 'approve' | 'reject';
}

export function ActionForm({
  action,
  hidden,
  buttonField = 'value',
  buttons,
  label,
  pendingLabel,
  className = '',
  messageClassName = 'text-[11px] leading-snug text-ink-2',
  textInput,
  hotkeyRole,
  children,
}: {
  action: (prev: string | null, formData: FormData) => Promise<string>;
  hidden?: Record<string, string | number>;
  /** buttons 를 쓸 때, 눌린 버튼의 값이 formData 에 실릴 필드 이름 */
  buttonField?: string;
  /** 값이 다른 버튼을 한 폼에 여럿 둘 때 — label/pendingLabel 대신 이것을 준다 */
  buttons?: ActionFormButton[];
  /** buttons 를 안 줄 때(버튼 하나) 쓰는 기존 방식 */
  label?: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  messageClassName?: string;
  /** 글을 적어 보내는 버튼일 때. 이름과 안내 문구를 준다 */
  textInput?: { name: string; placeholder: string };
  hotkeyRole?: 'approve' | 'reject';
  /** 버튼 앞에 끼워 넣을 부가 입력 — select, 파일 입력 등 */
  children?: React.ReactNode;
}) {
  const [message, formAction, pending] = useActionState(action, null);
  const router = useRouter();
  // buttons 모드에서 실제로 누른 버튼만 처리 중 문구로 바꾸기 위한 표시
  const [clickedValue, setClickedValue] = useState<string | null>(null);

  // 작업이 끝나면 화면의 숫자를 새로 읽는다. 주소를 바꾸지 않으므로
  // 스크롤 위치도 펼쳐 둔 항목도 그대로 남는다.
  useEffect(() => {
    if (message) router.refresh();
  }, [message, router]);

  const stacked = Boolean(textInput || children);

  return (
    <span className={stacked ? 'block' : 'inline-flex flex-wrap items-center gap-2'}>
      <form action={formAction} className={stacked ? 'flex flex-wrap items-center gap-2' : ''}>
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
        {children}
        {buttons ? (
          buttons.map((b) => (
            <button
              key={b.value}
              type="submit"
              name={buttonField}
              value={b.value}
              disabled={pending}
              aria-busy={pending && clickedValue === b.value}
              data-review-action={b.hotkeyRole}
              onClick={() => setClickedValue(b.value)}
              className={`${b.className ?? ''} ${pending ? 'cursor-wait opacity-60' : ''}`}
            >
              {pending && clickedValue === b.value ? b.pendingLabel : b.label}
            </button>
          ))
        ) : (
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            data-review-action={hotkeyRole}
            className={`${className} ${pending ? 'cursor-wait opacity-60' : ''}`}
          >
            {pending ? pendingLabel : label}
          </button>
        )}
      </form>
      {message && (
        <span className={`${messageClassName} ${stacked ? 'mt-2 block' : ''}`}>{message}</span>
      )}
    </span>
  );
}
