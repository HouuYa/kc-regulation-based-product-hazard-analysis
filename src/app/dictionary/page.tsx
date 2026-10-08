import Link from 'next/link';
import { PageHead } from '@/components/Panel';
import { KeywordTab } from './KeywordTab';
import { LinkTab } from './LinkTab';
import { TermTab } from './TermTab';

export const dynamic = 'force-dynamic';

/**
 * 화면 — 품목 판정 사전 (옛 /keywords + /terms, 05 §4.4 · 체크리스트 P3-4)
 *
 * 왜 합쳤는가
 *   "이 제품이 왜 이 기준으로 갔는가"를 따라가려면 사전 셋을 차례로 봐야 하는데,
 *   화면이 둘로 나뉘어 있고 그중 하나(품목→기준)는 `?view=link` 안에 숨어 있었다.
 *   담당자는 어느 화면에서 무엇을 고쳐야 하는지부터 헤맸다.
 *
 * 왜 한 목록으로 섞지 않고 탭으로 갈래를 남겼는가 (담당자 결정, "합치되 탭으로 갈래를 남기는 안")
 *   세 사전은 다루는 표(item_keyword · taxonomy_standard · scope_term)도, 검수 단위도,
 *   틀렸을 때 번지는 범위도 다르다. 한 목록에 섞으면 어떤 판단을 하고 있는지가 흐려진다.
 *
 * 탭은 주소에 싣는다(?tab=keyword|link|term)
 *   다른 화면들과 같은 방식이다(docs/화면_구조_개편_탭에서_URL_분리_2026-09-14.md) —
 *   주소를 복사해 보내면 같은 탭이 열리고 뒤로 가기가 동작한다.
 */

const TABS = [
  { value: 'keyword', label: '검색어', sub: '일상어 → 법정 품목' },
  { value: 'link', label: '품목→기준', sub: '법정 품목 → 적용 기준' },
  { value: 'term', label: '서류 제품명', sub: '서류 표기 → 적용 기준' },
] as const;

type TabValue = (typeof TABS)[number]['value'];

export default async function DictionaryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const tab: TabValue = TABS.some((t) => t.value === params.tab) ? (params.tab as TabValue) : 'keyword';

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="참고"
        title="품목 판정 사전"
        lead="서류에 적힌 제품 이름을 어느 KC안전기준으로 볼지 정하는 사전입니다. 분석은 여기서 정해진 기준의 조항만 뒤지므로, 이 사전이 틀리면 다른 제품의 시험이 근거로 제시됩니다."
      />

      {/*
        실제로 찾는 순서는 src/lib/cases/resolve-scope.ts 의 resolveProductScope 를 그대로 옮겼다.
        서류 제품명 사전이 가장 먼저다 — 담당자가 정한 대응을 두고 기계가 다시 고를 이유가 없다.
        순서를 바꾸려면 화면이 아니라 그 함수를 먼저 고쳐야 한다.
      */}
      <div className="mt-5 border border-rule-soft px-4 py-3 text-[12px] leading-relaxed text-ink-2">
        <div className="text-ink">제품이 기준으로 가는 길 — 위에서부터 차례로 보고, 먼저 걸린 것을 씁니다</div>
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
          <li>
            <span className="text-ink">서류 표기</span>가 「서류 제품명」 사전에 있으면 거기 이어 둔{' '}
            <span className="text-ink">적용 기준</span>을 바로 씁니다.
          </li>
          <li>
            없으면 <span className="text-ink">검색어</span>로 <span className="text-ink">법정 품목</span>을 찾고,
            그 품목의 기준(품목명이 같은 기준, 또는 「품목→기준」에서 확정한 대응)을 씁니다.
            여러 품목에 걸친 검색어는 쓰지 않습니다.
          </li>
          <li>
            그래도 없으면 등록된 품목 이름·별칭을 보고, 다음으로 기준의 적용범위 원문을 글자로, 그다음 뜻으로
            찾습니다. 뜻으로 찾은 대응은 「서류 제품명」에 미검수로 쌓입니다.
          </li>
        </ol>
        <p className="mt-1.5 text-ink-3">
          검색어의 AI 제안, 「품목→기준」 대응, 「서류 제품명」의 AI 제안은 확정하기 전에는 쓰이지 않습니다.
          예외로 적용범위 뜻 검색이 쌓은 대응은 미검수여도 쓰입니다 — 근거가 기준 자신의 적용범위 원문이기
          때문입니다. 반려한 것은 어디서도 쓰이지 않습니다.
        </p>
      </div>

      <nav className="mt-6 flex flex-wrap gap-2" aria-label="사전 갈래">
        {TABS.map((t) => {
          const active = t.value === tab;
          return (
            <Link
              key={t.value}
              href={`/dictionary?tab=${t.value}`}
              aria-current={active ? 'page' : undefined}
              className={`border px-4 py-2 text-[13px] font-medium ${
                active
                  ? 'border-measure bg-measure text-white'
                  : 'border-rule text-ink-2 hover:bg-measure-soft'
              }`}
            >
              {t.label}
              <span className={`ml-2 text-[11px] font-normal ${active ? 'text-white/80' : 'text-ink-3'}`}>
                {t.sub}
              </span>
            </Link>
          );
        })}
      </nav>

      {tab === 'keyword' && <KeywordTab params={params} />}
      {tab === 'link' && <LinkTab params={params} />}
      {tab === 'term' && <TermTab params={{ ...params, tab: 'term' }} />}
    </div>
  );
}
