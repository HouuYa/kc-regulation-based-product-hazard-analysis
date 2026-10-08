import { redirect } from 'next/navigation';

/**
 * 옛 주소 — 🤖 AI 사용 화면은 관리 화면(/admin)의 「AI 사용과 비용」 탭으로 들어갔다 (P3-6).
 *
 * 문서와 코드 주석(src/lib/llm/catalog.ts 등)이 /llm 을 가리키므로 주소는 살려 둔다.
 */
export default function LlmRedirect() {
  redirect('/admin?tab=llm');
}
