import Link from 'next/link';

/**
 * 화면 맨 위의 현황 요약
 *
 * 담당자 지적: "위쪽에 현황 표시 — 전체 갯수, 코드 부여, 의미 검색 준비, 시험 건수…"
 *
 * 목록만 있는 화면은 "지금 어디까지 됐는가"를 답해 주지 못한다. 스크롤을 끝까지
 * 내려 세어 봐야 아는 것은 화면이 일을 안 한 것이다. 세 업무 화면이 같은 모양의
 * 요약을 위에 두고, 숫자 하나하나가 "다음에 무엇을 해야 하는가"로 이어지게 한다.
 *
 * 분모를 조심해서 고른다
 *   라운드 18에서 겪은 일이 근거다. 첫 화면이 "임베딩 498 / 13,501" 로 보여 주고
 *   있었는데, 이는 96%가 밀린 것처럼 읽혔다. 실제로는 13,003건이 아직 코드 부여
 *   전이라 의미 검색을 준비할 재료 자체가 없는 상태였다. 분모를 "할 수 있는 것"
 *   으로 잡아야 숫자가 사실을 말한다.
 */

export interface MetricItem {
  label: string;
  value: number;
  /** 분모. 없으면 값이 1 이상일 때 완료로 본다 */
  of?: number;
  note?: string;
  href?: string;
  /** 0 이 아니면 확인이 필요하다는 뜻 — 숫자를 주의색으로 그린다 */
  wantsZero?: boolean;
}

function Metric({ label, value, of, note, href, wantsZero }: MetricItem) {
  const ready = wantsZero ? value === 0 : of == null ? value > 0 : of > 0 && value >= of;
  const tone = wantsZero && value > 0 ? 'text-caution' : ready ? 'text-ink' : 'text-ink-3';

  const body = (
    <div className="border-t border-rule pt-3">
      <div className="label">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={`addr tnum text-[26px] leading-none font-medium ${tone}`}>
          {value.toLocaleString()}
        </span>
        {of != null && (
          <span className="addr tnum text-[13px] text-ink-3">/ {of.toLocaleString()}</span>
        )}
      </div>
      {note && (
        <details className="mt-1.5 text-[11px] leading-snug text-ink-3">
          <summary className="cursor-pointer hover:text-ink">설명</summary>
          <div className="mt-1">{note}</div>
        </details>
      )}
    </div>
  );

  return href ? (
    <Link href={href} className="block hover:opacity-70">
      {body}
    </Link>
  ) : (
    body
  );
}

export function StatusBar({ items }: { items: MetricItem[] }) {
  return (
    <section className="mt-8 grid grid-cols-2 gap-x-5 gap-y-4 md:mt-9 md:gap-x-8 md:gap-y-6 md:grid-cols-4">
      {items.map((m) => (
        <Metric key={m.label} {...m} />
      ))}
    </section>
  );
}
