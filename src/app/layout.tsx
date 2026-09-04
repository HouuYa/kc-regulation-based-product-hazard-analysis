import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'KC안전기준 제품위해 분석',
  description: '제품사고와 안전기준 조항을 위해요인 코드로 잇는 분석 콘솔',
};

/**
 * 좌측 레일은 장식이 아니라 업무 그 자체다.
 *
 * 무엇이 바뀌었나 (담당자 요청)
 *   전에는 「1 안전기준 / 2 위해요인 코드 / 3 사건 / 4 분석」이었다. 두 가지를 고쳤다.
 *
 *   위해요인 코드를 아래로 내렸다 — 그것은 업무 단계가 아니라 참고 문서다.
 *   코드북은 조회만 하는 대상이고 담당자가 그 화면에서 할 일이 없다.
 *
 *   사건·분석을 사고보고서와 리콜로 나눴다 — 둘은 들어오는 경로도 봐야 할 숫자도
 *   다르다. 사고보고서는 사람이 PDF 를 올리고 원문을 확인해야 하고, 리콜은 외부 표에서
 *   자동으로 들어오며 코드까지 붙어 온다. 한 통에 담으면 어느 쪽이 밀렸는지 알 수 없다.
 *   등록과 분석을 따로 두지 않고 한 화면에 합친 것은, 담당자가 "사고보고서 + KC안전기준
 *   연계 분석"을 하나의 일로 인식하기 때문이다.
 */
const STAGES = [
  { no: '1', href: '/standards', label: '안전기준',   sub: '조항·시험 적재' },
  { no: '2', href: '/accidents', label: '사고보고서', sub: '등록·현황·분석' },
  { no: '3', href: '/recalls',   label: '리콜',       sub: '수집·현황·분석' },
];

/** 업무 흐름 위에 있지 않은 것들 — 번호를 주지 않고 선 아래에 둔다 */
const ASIDE = [
  // 세 번째 산출물. 1~3 의 결과가 쌓여야 숫자가 생기므로 흐름 뒤에 둔다
  { href: '/insights',  label: 'KC안전기준 개선 요인', sub: '사각지대·국내외 대조·시험항목' },
  { href: '/ops',      label: '운영',         sub: '상태·알림·접속 관리' },
  { href: '/codebook', label: '위해요인 코드', sub: '참고 문서' },
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
        <div className="min-h-screen lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
          {/*
            넓은 화면에서는 레일을 화면에 붙여 둔다 (담당자 지적:
            "좌측메뉴가 페이지 스크롤 다운하면 올라가 버리네요")

            목록이 수천 건이라 한참 내려가면 메뉴가 화면 밖으로 사라져,
            다른 화면으로 가려면 맨 위까지 되올라와야 했다.

            self-start 가 필요한 이유: 부모가 flex 라 기본값(stretch)으로 늘어나면
            sticky 가 붙을 여백이 없어 아무 효과가 없다. 높이를 내용만큼만 잡아야
            비로소 붙는다. 레일이 화면보다 길어질 때를 대비해 안쪽 스크롤도 준다.
          */}
          <nav className="border-b border-rule bg-surface lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-r lg:border-b-0">
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

            {/*
              좁은 화면에서는 가로로 눕힌다.
              세로로 쌓으면 단계 4개 + 운영이 화면 위쪽 250px 가량을 먹어, 정작 봐야 할
              본문이 스크롤 아래로 밀린다. 텔레그램 알림을 받고 휴대전화로 운영 화면을
              여는 경로가 실제로 생겼으므로(023) 이 낭비를 두고 볼 이유가 없다.
              넓은 화면에서는 원래대로 세로 레일이다.
            */}
            <div className="flex items-stretch overflow-x-auto px-2 py-3 lg:block lg:py-4">
              <ol className="flex lg:block">
                {STAGES.map((s) => (
                  <li key={s.href} className="shrink-0">
                    <Link
                      href={s.href}
                      className="group flex items-baseline gap-3 rounded-sm px-3 py-2.5 transition-colors hover:bg-measure-soft"
                    >
                      <span className="addr text-[11px] text-ink-3 group-hover:text-measure">
                        {s.no}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium whitespace-nowrap">
                          {s.label}
                        </span>
                        <span className="block text-[11px] whitespace-nowrap text-ink-3">
                          {s.sub}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>

              {/*
                운영과 참고 문서는 업무 흐름 위에 있지 않다 — 자료가 흐르는 순서(1~3)가
                아니라 "그 흐름이 지금 돌고 있는가"와 "무엇을 기준으로 삼는가"를 보는
                자리다. 그래서 번호를 주지 않고 선 하나를 사이에 둔다. 번호가 의미를
                담고 있으므로 아무 데나 4를 붙이면 그 의미가 깨진다.
              */}
              <ul className="ml-2 flex shrink-0 border-l border-rule-soft pl-2 lg:mt-3 lg:ml-0 lg:block lg:border-t lg:border-l-0 lg:pt-3 lg:pl-0">
                {ASIDE.map((a) => (
                  <li key={a.href} className="shrink-0">
                    <Link
                      href={a.href}
                      className="group block rounded-sm px-3 py-2.5 transition-colors hover:bg-measure-soft"
                    >
                      <span className="block text-[13px] font-medium whitespace-nowrap group-hover:text-measure">
                        {a.label}
                      </span>
                      <span className="block text-[11px] whitespace-nowrap text-ink-3">
                        {a.sub}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* 이 도구의 성격을 화면에 상주시킨다. 담당자가 결과를 판정으로 읽지 않도록. */}
            <p className="mx-5 mb-5 hidden border-t border-rule-soft pt-4 text-[11px] leading-relaxed text-ink-3 lg:block">
              이 시스템은 위반 여부를 판정하지 않습니다. 관련될 수 있는 조항과 그 근거를
              제시하고, 확인 여부는 담당자가 정합니다.
            </p>
          </nav>

          <main id="top" className="min-w-0">{children}</main>
        </div>
      </body>
    </html>
  );
}
