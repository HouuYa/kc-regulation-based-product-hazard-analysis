'use client';

/**
 * 예상 못 한 오류가 났을 때의 화면
 *
 * 이것이 없으면 Next.js 가 아무 설명 없는 기본 오류 화면을 띄운다. 담당자 입장에서는
 * "사이트가 죽었다"와 "이 화면 하나가 죽었다"가 구분되지 않고, 무엇을 해야 하는지도
 * 알 수 없다. 그 둘을 구분해 주고 다음 행동을 알려 주는 것이 이 파일의 일이다.
 *
 * 오류 내용을 화면에 쓰지 않는다
 *   Next.js 는 배포 환경에서 오류 메시지를 이미 지우고 digest 만 남긴다. 여기서
 *   굳이 되살릴 이유가 없다 — 담당자가 할 수 있는 일은 어차피 다시 시도하거나
 *   운영 화면을 보는 것뿐이다. 원인은 서버 기록에 남는다.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 lg:px-10">
      <div className="label">오류</div>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight">
        이 화면을 그리지 못했습니다
      </h1>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
        시스템 전체가 멈춘 것은 아닐 수 있습니다. 다시 시도해 보시고, 계속 같으면
        운영 화면에서 자동 배치와 데이터베이스 상태를 확인하세요.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={reset}
          className="border border-measure bg-measure px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
        >
          다시 시도
        </button>
        <a
          href="/ops"
          className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-measure-soft"
        >
          운영 화면으로
        </a>
      </div>

      {error.digest && (
        <p className="mt-8 border-t border-rule pt-4 text-[11px] text-ink-3">
          서버 기록에서 이 오류를 찾을 때 쓰는 번호:{' '}
          <code className="addr text-ink-2">{error.digest}</code>
        </p>
      )}
    </div>
  );
}
