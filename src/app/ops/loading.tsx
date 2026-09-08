import { PageSkeleton } from '@/components/PageSkeleton';

/**
 * 운영 화면이 조회를 기다리는 동안 (§4.1)
 *
 * 이 화면은 조회가 가장 무겁다 — 현황 7종에 목록까지 본다. 그만큼 뼈대의
 * 값어치도 크다. 담당자가 "시스템이 도는가"를 보러 왔는데 빈 화면이 뜨면
 * 그 자체가 고장으로 읽힌다.
 */
export default function Loading() {
  return (
    <PageSkeleton
      label="운영"
      title="시스템이 지금 제대로 돌고 있는가"
      lead="자동 작업 상태와 확인할 문제를 보여 줍니다. 문제가 없으면 조치할 일이 없습니다."
      workflow={[
        { label: '자동으로 돎' },
        { label: '문제 찾기' },
        { label: '알림' },
        { label: '손보기', who: '사람' },
      ]}
      rows={4}
    />
  );
}
