import { PageHead } from '@/components/Panel';

/**
 * 조회가 끝나기 전에 먼저 보여 주는 뼈대
 *
 * 무엇이 문제였나 (02_1차 보완 및 구현 설계서 §4.1)
 *   사고보고서·리콜·운영 화면은 요약 집계, 전체 건수, 목록을 서버에서 차례로
 *   조회한 뒤에야 그려졌다. 그동안 담당자에게는 아무것도 보이지 않는다 —
 *   제목도, 업무 흐름도, "불러오는 중"이라는 말조차 없다. 느린 것과 고장 난 것을
 *   구별할 방법이 없는 상태다.
 *
 *   Next.js 는 route 폴더에 loading.tsx 가 있으면 서버 조회를 기다리는 동안
 *   그것을 먼저 그린다. 조회가 빨라지는 것은 아니지만, 담당자는 화면이 살아
 *   있다는 것과 자기가 어디에 있는지를 즉시 안다.
 *
 * 왜 제목과 업무 흐름을 진짜로 그리는가
 *   회색 상자만 늘어놓는 뼈대는 "무언가 뜬다"는 것 외에 아무것도 알려 주지 않는다.
 *   제목과 업무 흐름은 조회 결과와 상관없이 언제나 같은 값이므로, 흉내 내지 말고
 *   실제 화면과 같은 것을 그대로 보여 준다. 숫자와 목록만 자리를 비워 둔다.
 */
export function PageSkeleton({
  label, title, lead, workflow, rows = 6,
}: {
  label: string;
  title: string;
  lead?: string;
  workflow?: Array<{ label: string; href?: string }>;
  /** 목록 자리에 비워 둘 줄 수 */
  rows?: number;
}) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_10rem]">
        <div>
          <PageHead label={label} title={title} lead={lead} workflow={workflow} />

          <p className="mt-8 text-[12px] text-ink-3" role="status" aria-live="polite">
            불러오는 중입니다…
          </p>

          {/* 요약 숫자 자리 */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="border border-rule-soft px-3 py-4">
                <div className="h-2.5 w-14 animate-pulse bg-rule-soft" />
                <div className="mt-2.5 h-4 w-10 animate-pulse bg-rule-soft" />
              </div>
            ))}
          </div>

          {/* 목록 자리 */}
          <div className="mt-8 border-t border-rule-soft">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-4 border-b border-rule-soft py-3.5">
                <div className="h-2.5 w-1/3 animate-pulse bg-rule-soft" />
                <div className="h-2.5 w-16 animate-pulse bg-rule-soft" />
                <div className="ml-auto h-2.5 w-12 animate-pulse bg-rule-soft" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
