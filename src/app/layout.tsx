import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'KC안전기준 제품위해 분석',
  description: '제품사고와 안전기준 조항을 위해요인 코드로 잇는 분석 콘솔',
};

/**
 * 좌측 레일은 장식이 아니라 파이프라인 그 자체다.
 *
 * 이 시스템에서 데이터는 한 방향으로 흐른다 — 적재 → 태깅 → 분석 → 검토.
 * 담당자가 "지금 어디까지 준비됐는가"를 늘 알아야 하므로 그 순서를 화면에 고정한다.
 * 순서가 정보를 담고 있으니 번호를 붙일 자격이 있다(임의로 붙인 01/02/03 이 아니다).
 */
const STAGES = [
  { no: '1', href: '/standards', label: '안전기준', sub: '조항·시험조건 적재' },
  { no: '2', href: '/codebook',  label: '위해요인 코드', sub: '코드북 스냅샷' },
  { no: '3', href: '/cases',     label: '사건',       sub: '사고보고서·리콜' },
  { no: '4', href: '/analysis',  label: '분석',       sub: '시험 후보군' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="flex min-h-screen flex-col lg:flex-row">
          <nav className="shrink-0 border-b border-rule bg-surface lg:w-60 lg:border-r lg:border-b-0">
            <div className="border-b border-rule-soft px-5 py-5">
              <Link href="/" className="block">
                <div className="label">국가기술표준원</div>
                <div className="mt-1 text-[15px] leading-tight font-semibold tracking-tight">
                  KC안전기준
                  <br />
                  제품위해 분석
                </div>
              </Link>
            </div>

            <ol className="px-2 py-3 lg:py-4">
              {STAGES.map((s) => (
                <li key={s.href}>
                  <Link
                    href={s.href}
                    className="group flex items-baseline gap-3 rounded-sm px-3 py-2.5 transition-colors hover:bg-measure-soft"
                  >
                    <span className="addr text-[11px] text-ink-3 group-hover:text-measure">
                      {s.no}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{s.label}</span>
                      <span className="block text-[11px] text-ink-3">{s.sub}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>

            {/* 이 도구의 성격을 화면에 상주시킨다. 담당자가 결과를 판정으로 읽지 않도록. */}
            <p className="mx-5 mb-5 hidden border-t border-rule-soft pt-4 text-[11px] leading-relaxed text-ink-3 lg:block">
              이 시스템은 위반 여부를 판정하지 않습니다. 관련될 수 있는 조항과 그 근거를
              제시하고, 확인 여부는 담당자가 정합니다.
            </p>
          </nav>

          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
