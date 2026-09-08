import { PageSkeleton } from '@/components/PageSkeleton';

/** 리콜 화면이 조회를 기다리는 동안 (§4.1) */
export default function Loading() {
  return (
    <PageSkeleton
      label="3 · 리콜"
      title="리콜과 안전기준 연계 분석"
      lead="리콜 자료를 확인하고 국내 유통 여부를 기록한 뒤, 관련될 수 있는 안전기준을 찾습니다."
      workflow={[
        { label: '리콜 수집' },
        { label: '위해요인 코드' },
        { label: '뜻 검색 준비' },
        { label: '분석', who: '사람' },
        { label: '국내 유통 확인', who: '사람' },
      ]}
    />
  );
}
