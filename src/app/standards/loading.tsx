import { PageSkeleton } from '@/components/PageSkeleton';

/** 안전기준 화면이 조회를 기다리는 동안 (§4.1) */
export default function Loading() {
  return (
    <PageSkeleton
      label="1 · 안전기준"
      title="들여온 기준과 준비 상태"
      lead="기준을 확인하고, 조항과 시험방법이 분석에 쓸 수 있는 상태인지 봅니다."
      workflow={[
        { label: '기준 확인' },
        { label: '조항 확인' },
        { label: '시험방법 확인' },
        { label: '분석에 사용' },
      ]}
    />
  );
}
