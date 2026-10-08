import { PageSkeleton } from '@/components/PageSkeleton';

/** 리콜 화면이 조회를 기다리는 동안 (§4.1) — 머리말은 page.tsx 와 같게 둔다 */
export default function Loading() {
  return (
    <PageSkeleton
      label="업무 · 리콜 분석"
      title="리콜이 국내와 관계있는지 가리고, 관련 조항을 찾습니다"
      lead="1단계에서 국내 유통 여부를 기록하고(품목은 자동 판정·원본 분류가 차려 두었으니 확인만, 비어 있는 것만 정하고), 2단계에서 관련될 수 있는 안전기준 조항을 찾아 채택합니다. 두 단계 모두 이 화면에서 합니다."
      workflow={[
        { label: '리콜 수집' },
        { label: '1단계 품목 분류', who: '사람' },
        { label: '1단계 국내 유통 확인', who: '사람' },
        { label: '2단계 조항 찾기·채택', who: '사람' },
      ]}
    />
  );
}
