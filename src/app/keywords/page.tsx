import { redirect } from 'next/navigation';

/**
 * 옛 주소 — 검색어 사전은 「품목 판정 사전」(/dictionary)의 탭으로 들어갔다.
 *
 * 법정 품목 → 기준 대응(?view=link·nomatch)은 「품목→기준」 탭으로, 나머지 보기는
 * 「검색어」 탭으로 보낸다. 다른 조건(q·page)은 그대로 실어 북마크가 같은 화면을 열게 한다.
 */
export default async function KeywordsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && k !== 'tab') sp.set(k, v);
  }
  const view = sp.get('view');
  sp.set('tab', view === 'link' || view === 'nomatch' ? 'link' : 'keyword');
  redirect(`/dictionary?${sp.toString()}`);
}
