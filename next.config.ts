import type { NextConfig } from 'next';

/**
 * Next.js 설정 — 지금은 한 가지 일만 한다
 *
 * 안전기준 원본 폴더를 서버 번들에 포함시킨다
 *   /api/jobs/standards-sync 는 KC안전기준/ 폴더의 JSON 76개를 읽어 새 기준이나
 *   개정본이 있는지 본다. 그런데 Next.js 는 코드에서 정적으로 참조한 파일만
 *   배포판에 담는다 — 이 폴더는 readdirSync(dir) 로 실행 중에 읽으므로
 *   그냥 두면 배포 환경에 파일이 없어 "폴더가 비었다"로 조용히 끝난다.
 *
 *   로컬에서는 저장소 전체가 있으니 문제가 드러나지 않고, 배포한 뒤에야
 *   "왜 아무것도 안 잡히지"가 된다. 그 조용한 실패를 막으려고 명시한다.
 *
 * 폴더가 저장소에 있는 것은 확인했다
 *   git 에 76개 JSON 이 커밋돼 있다. 사고조사보고서 PDF 와 달리 개인정보가 아니라
 *   공개된 기준 문서라 저장소에 두는 것이 맞다.
 */
const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/api/jobs/[job]': ['./KC안전기준/**'],
  },
};

export default nextConfig;
