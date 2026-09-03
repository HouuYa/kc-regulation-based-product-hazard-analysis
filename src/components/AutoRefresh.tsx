'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 오래 걸리는 일이 도는 동안 화면 숫자를 스스로 새로 읽는다
 *
 * 담당자 요청: "분석 실행 및 통계 자동 업데이트, 시간이 많이 걸리는 작업에 대해
 * 현황 잘 나오도록 하기"
 *
 * 왜 필요한가
 *   코드 부여 자동 실행은 몇 시간 동안 돈다. 의미 검색 준비도 1분마다 조금씩 는다.
 *   그런데 화면은 열었을 때의 숫자에서 멈춰 있어서, 담당자가 진행 상황을 보려면
 *   새로고침을 눌러야 했다. 몇 시간짜리 일을 지켜보면서 계속 F5 를 누르는 것은
 *   화면이 할 일을 사람에게 떠넘기는 것이다.
 *
 * 돌아가는 일이 있을 때만 켠다
 *   할 일이 없는데도 계속 서버를 두드리면 그것대로 낭비다. 화면이 "지금 무언가
 *   진행 중"이라고 판단했을 때만(active) 주기적으로 새로 읽는다.
 *
 * 주소를 바꾸지 않는다
 *   router.refresh() 는 서버 데이터만 다시 받아 온다. 스크롤 위치도, 펼쳐 둔
 *   항목도, 입력하던 글자도 그대로 남는다. 그래서 보고 있는 중에 끼어들지 않는다.
 */
export function AutoRefresh({
  active,
  seconds = 15,
  label = '진행 중 — 화면이 스스로 갱신됩니다',
}: {
  active: boolean;
  seconds?: number;
  label?: string;
}) {
  const router = useRouter();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      router.refresh();
      setTick((n) => n + 1);
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [active, seconds, router]);

  if (!active) return null;

  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-measure">
      <span aria-hidden className="inline-block size-1.5 animate-pulse rounded-full bg-measure" />
      {label}
      {tick > 0 && <span className="text-ink-3">({tick}회 갱신함)</span>}
    </span>
  );
}
