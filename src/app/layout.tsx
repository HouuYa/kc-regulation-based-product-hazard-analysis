import type { Metadata } from 'next';
import { SideNav } from '@/components/SideNav';
import { StageProvider } from '@/components/StageContext';
import './globals.css';

export const metadata: Metadata = {
  title: 'KC안전기준 제품위해 분석',
  description: '제품사고와 안전기준 조항을 위해요인 코드로 잇는 분석 콘솔',
};

/**
 * 업무 흐름 레일은 기본은 숨기고 ☰ 아이콘으로 연다 (2026-09-14, 와이어프레임 3a)
 *
 * 전에는 이 레일이 항상 화면에 붙어 있었다(넓은 화면 sticky, 좁은 화면 상단
 * 가로줄). "좌·우 메뉴가 이중 내비게이션처럼 느껴진다"는 지적에 따라, 본문이
 * 전체 폭을 쓰고 레일은 필요할 때만 여는 오버레이로 옮겼다. 실제 목록·상태·
 * 토글 로직은 클라이언트 컴포넌트여야 해서 `SideNav` 로 옮겼다.
 */
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
        <StageProvider>
          <SideNav />
          <main id="top" className="min-h-screen min-w-0">{children}</main>
        </StageProvider>
      </body>
    </html>
  );
}
