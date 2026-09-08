import { PageSkeleton } from '@/components/PageSkeleton';

/**
 * 사고보고서 화면이 조회를 기다리는 동안 (§4.1)
 *
 * 제목·업무 흐름은 조회 결과와 무관하게 늘 같으므로 실제 화면과 똑같이 적는다.
 * page.tsx 의 PageHead 와 값이 어긋나면 뼈대에서 본문으로 넘어갈 때 글자가
 * 바뀌어 깜빡인다.
 */
export default function Loading() {
  return (
    <PageSkeleton
      label="2 · 사고보고서"
      title="사고보고서와 안전기준 연계 분석"
      lead="PDF를 올리고 원문을 확인하면, 사고와 관련될 수 있는 안전기준 조항을 찾습니다."
      workflow={[
        { label: '올리기', who: '사람' },
        { label: '글자·개인정보 검사' },
        { label: '원문 확인', who: '사람' },
        { label: '코드·검색 준비' },
        { label: '분석', who: '사람' },
        { label: '검수·채택', who: '사람' },
      ]}
    />
  );
}
