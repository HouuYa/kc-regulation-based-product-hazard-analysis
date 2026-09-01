import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 사고보고서 PDF 다건 업로드 — Server Action 본문 크기 상향 (8.1)
  experimental: {
    serverActions: { bodySizeLimit: '25mb' },
  },
};

export default nextConfig;
