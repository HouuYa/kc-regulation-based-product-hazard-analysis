'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * 좌측 메뉴에 "지금 여기" 를 알려 주는 자리 (2026-09-14, 담당자 요청)
 *
 * "현재보는 페이지가 어디인지 좌측 메뉴 네비게이션에 표시해 달라" —
 * `SideNav.tsx`는 이미 주소(pathname)로 강조하는 항목을 고르고 있지만,
 * `/analysis/[caseId]`(사건 상세)는 메뉴 목록에 없는 화면이라 못 맞힌다.
 * "이 사건이 사고보고서인가 리콜인가"는 URL 만으로는 안 갈리고, 그 사건
 * 데이터는 그 라우트 안(`analysis/[caseId]/layout.tsx`, 서버 컴포넌트)에서만
 * 조회된다 — 좌측 메뉴는 루트 레이아웃에 딱 한 번 떠 있는 전역 컴포넌트라
 * 그 데이터를 알 방법이 없다.
 *
 * 그래서 작은 다리를 놓는다. 이 컨텍스트를 루트 레이아웃이 SideNav 와
 * children 을 함께 감싸는 자리에 둔다. `analysis/[caseId]/layout.tsx`는
 * 자신이 아는 것(사고보고서인지 리콜인지)을 `<StageAnnouncer>`(클라이언트
 * 컴포넌트, 렌더링은 없음)로 흘려보내고, SideNav 는 그 값을 읽어 자기
 * 항목 중 하나를 "지금 여기"로 강조한다.
 *
 * 사건을 벗어나면 저절로 지운다 — `analysis/[caseId]/layout.tsx` 자체가
 * 언마운트되면(다른 사건으로 가거나 메뉴의 다른 화면으로 이동하면) 이
 * 컴포넌트의 정리 함수가 stage 를 null 로 되돌린다. 검토⇄인사이트처럼 같은
 * 레이아웃 아래 화면만 오갈 때는 레이아웃이 그대로 남아 있어 깜빡이지 않는다.
 */
const StageContext = createContext<{
  stage: string | null;
  setStage: (stage: string | null) => void;
}>({ stage: null, setStage: () => {} });

export function StageProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<string | null>(null);
  return (
    <StageContext.Provider value={{ stage, setStage }}>
      {children}
    </StageContext.Provider>
  );
}

export function useStage(): string | null {
  return useContext(StageContext).stage;
}

/** 화면은 그리지 않는다 — SideNav 가 강조할 항목의 주소만 컨텍스트로 알린다 */
export function StageAnnouncer({ stage }: { stage: string }) {
  const { setStage } = useContext(StageContext);
  useEffect(() => {
    setStage(stage);
    return () => setStage(null);
  }, [stage, setStage]);
  return null;
}
