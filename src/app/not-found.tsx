import Link from 'next/link';

/**
 * 없는 주소로 들어왔을 때.
 *
 * 이 시스템에서 흔한 경우는 하나다 — 지워졌거나 아직 만들어지지 않은 사건 번호
 * (/analysis/999). 그래서 "없다"로 끝내지 않고 목록으로 돌려보낸다.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 lg:px-10">
      <div className="label">찾을 수 없음</div>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight">
        그 주소에는 아무것도 없습니다
      </h1>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
        주소가 잘못됐거나, 가리키던 자료가 지워졌습니다. 사건 번호로 들어오셨다면 그
        사건이 아직 등록되지 않았을 수 있습니다.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href="/"
          className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-measure-soft"
        >
          개요로
        </Link>
        <Link
          href="/analysis"
          className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-measure-soft"
        >
          사건 목록으로
        </Link>
      </div>
    </div>
  );
}
