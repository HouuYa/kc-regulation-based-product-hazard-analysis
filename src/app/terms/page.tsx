import { redirect } from 'next/navigation';

/**
 * 옛 주소 — 용어 사전은 「품목 판정 사전」(/dictionary)의 「서류 제품명」 탭으로 들어갔다.
 *
 * 조건(q·group·status·page·per·sort·dir)은 그대로 싣는다. 「서류 제품명」 탭의 찾기 폼도
 * 이 주소를 거쳐 간다(TermTab.tsx 주석) — 이 넘겨주기를 지우려면 그 폼부터 고쳐야 한다.
 */
export default async function TermsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && k !== 'tab') sp.set(k, v);
  }
  sp.set('tab', 'term');
  redirect(`/dictionary?${sp.toString()}`);
}
