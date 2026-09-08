/**
 * AI 별칭 생성 — 법정 품목을 일상에서 뭐라고 부르는가 (04-2 §5.3)
 *
 * 왜 여전히 필요한가
 *   담당자가 만든 사전이 있지만 미완성이다. 법정 품목 623종 중 별칭이 붙은 것은
 *   217종뿐이고, 해외 리콜 1,553종 중 이 사전으로 곧바로 이어지는 것은 81종이다.
 *   나머지를 사람이 손으로 채우는 것은 담당자 시간을 가장 비싸게 쓰는 방법이다.
 *
 * 지어낸 말을 그냥 믿지 않는다 — 두 겹으로 잰다
 *   1) 사람 사전을 정답지로 쓴다. 담당자가 「전선」에 붙인 별칭 6개를 **가리고**
 *      AI 에게 만들게 한 뒤 몇 개를 맞히는지 잰다. 정답이 있는 채점이다.
 *   2) 실물로 확인한다. 지어낸 별칭이 실제 해외 리콜 품목명 1,553종 중 몇 종을
 *      새로 덮는지 센다. 아무도 안 쓰는 말을 만들면 이 숫자가 안 오른다.
 *
 *   두 숫자가 함께 좋아야 채택한다. 첫째만 좋으면 사람 흉내만 낸 것이고,
 *   둘째만 좋으면 엉뚱한 말을 마구 붙인 것일 수 있다.
 *
 * 사람 것을 덮지 않는다
 *   source='LLM' 으로 따로 담고, 담당자가 확정하기 전에는 미검수로 둔다.
 */

import { getDb } from '../db';
import { structuredCall } from '../llm/client';
import { openaiConfig } from '../env';

export interface AliasTarget {
  itemGroup: string;
  item: string | null;
  subItem: string | null;
  /** 이 품목이 어떤 것인지 알려 줄 참고 문구 (GPC 이름·정의) */
  hint: string | null;
}

export interface AliasSuggestion {
  target: AliasTarget;
  keywords: string[];
  note: string;
}

/*
  프롬프트를 고친 이유 (2026-09-06 채점으로 드러남)

  처음에는 "소비자가 부르는 다른 이름"을 모으라고 시켰다. 사람 사전을 정답지로 채점하니
  재현율이 9.6% 였는데, 예시를 보니 AI 가 못해서가 아니었다. **서로 다른 일을 하고
  있었다.**

    「망간 건전지」
      사람: 리튬전지 · 수은전지 · 버튼셀 · 알카라인배터리 · 배터리 …22개
      AI  : 망간전지 · 아연망간전지 · 망간 배터리 …7개

  사람 사전은 사전적 별칭이 아니라 **뉴스를 훑기 위한 검색 그물**이다(원본이
  「일일동향보고 검색용 데이터」다). 그래서 같은 계열의 이웃 품목까지 폭넓게 묶는다.
  AI 는 문자 그대로 정확한 별칭을 만들었으니 겹칠 리가 없었다.

  목적을 프롬프트에 적고, 사람이 만든 실제 예를 보여 그 결을 배우게 한다.
*/
const SYSTEM = [
  '너는 한국 제품안전 담당자를 돕는다.',
  '법정 품목명을 보고, **그 품목의 사고·리콜 기사를 뉴스에서 찾을 때 쓸 검색어**를 모은다.',
  '',
  '사전적 별칭만 모으는 것이 아니다. 담당자가 실제로 쓰는 검색 그물을 만든다.',
  '- 같은 물건의 다른 이름, 줄임말, 진열대에서 쓰는 말, 외래어 표기',
  '- **같은 계열의 이웃 품목까지 넉넉히 넣는다.** 그 기사가 이 품목의 사고일 수 있다면 넣는다.',
  '  예: 「망간 건전지」에는 리튬전지 · 수은전지 · 버튼셀 · 알카라인배터리 같은 다른 전지도 넣는다.',
  '  예: 「책상 및 테이블」에는 식탁 · 탁자 · 홈바 · 거실협탁 · 밥상처럼 형태가 다른 것도 넣는다.',
  '- 해외 리콜 기사를 한국어로 옮겼을 때 나올 표현도 넣는다.',
  '',
  '지켜야 할 것',
  '- 실제로 쓰이는 말만 넣는다. 그럴듯하게 지어내지 않는다.',
  '- 아주 넓은 상위 개념은 넣지 않는다. "가전제품", "생활용품" 같은 말은 아무 데나 걸린다.',
  '- 다른 뜻으로도 읽히는 조각말은 넣지 않는다. "세척기"만 넣으면 식기세척기까지 걸린다.',
  '- 한 품목에 5~15개.',
].join('\n');

/**
 * 사람이 만든 별칭을 예로 보여 준다 (few-shot)
 *
 * 결을 말로 설명하는 것보다 실제 예를 보이는 편이 정확하다. 다만 지금 물어보는 품목의
 * 답을 예로 주면 채점이 무의미해지므로, **묻는 품목은 예에서 뺀다.**
 *
 * 예를 무작위로 고르지 않는다 (2026-09-08)
 *   전에는 `order by random()` 이었다. 두 가지가 걸린다.
 *
 *   1) 부를 때마다 프롬프트 앞부분이 달라져 캐시가 절대 걸리지 않는다. 캐시된 입력은
 *      단가가 1/10 이고, 이 호출은 묶음마다 예시 다섯 개를 통째로 다시 보낸다.
 *   2) 같은 품목을 다시 물어도 답이 달라진 이유를 되짚을 수 없다. 예가 바뀌었는지
 *      모델이 흔들린 것인지 구별되지 않는다.
 *
 *   이름 순으로 고정한다. 예의 다양성보다 되짚을 수 있음이 먼저다.
 */
async function fewShot(exclude: AliasTarget[]): Promise<string> {
  const skip = exclude.map((t) => t.subItem ?? t.item ?? '');
  const rows = await getDb()<{ name: string; kws: string[] }[]>`
    select coalesce(sub_item, item) name, array_agg(keyword order by id) kws
    from public.item_keyword
    where source = 'EXPERT' and coalesce(sub_item, item, '') <> all(${skip})
    group by 1
    having count(*) between 4 and 12
    order by 1
    limit 5
  `;
  if (rows.length === 0) return '';
  return [
    '',
    '[담당자가 실제로 만든 예 — 이 결을 따른다]',
    ...rows.map((r) => `- ${r.name}: ${r.kws.join(', ')}`),
  ].join('\n');
}

/**
 * 대상 품목명을 enum 으로 못박는다 (2026-09-08)
 *
 * 검색어(별칭) 자체는 만들어 내는 것이라 고정할 수 없다 — 그것이 이 호출의 목적이다.
 * 하지만 **어느 품목에 붙일 것인가**는 우리가 물어본 목록 안에서만 나와야 한다.
 * 전에는 target 이 자유 문자열이라 이름이 살짝 어긋나면 그 묶음의 검색어가 통째로
 * 버려졌고, 버려진 사실도 아무 데도 남지 않았다.
 */
function buildSchema(names: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target: { type: 'string', enum: names },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: '이 품목을 사람들이 실제로 부르는 말. 두 글자 이상, 서른 글자 이하',
            },
            note: { type: 'string', description: '왜 이 말들을 골랐는지 한 줄' },
          },
          required: ['target', 'keywords', 'note'],
        },
      },
    },
    required: ['items'],
  } as const;
}

/** 한 번에 몇 품목을 물을 것인가. 크게 묶을수록 싸지만 답이 성의 없어진다 */
export const BATCH = 20;

/**
 * 별칭을 만들 대상을 고른다.
 *
 * @param onlyMissing 사람이 이미 별칭을 붙인 품목은 뺀다(기본). 채점할 때는 false 로
 *   두어 사람이 붙인 품목을 일부러 골라야 한다 — 그래야 정답과 견줄 수 있다.
 */
export async function aliasTargets(opts: { onlyMissing?: boolean; limit?: number } = {}): Promise<AliasTarget[]> {
  const db = getDb();
  const onlyMissing = opts.onlyMissing ?? true;

  const rows = await db<{
    item_group: string; item: string | null; sub_item: string | null; hint: string | null;
  }[]>`
    with target as (
      select distinct
        t.item_group,
        t.item,
        t.sub_item,
        -- GPC 이름을 힌트로 준다. 법정 품목명만으로는 무슨 물건인지 모호할 때가 있다
        (array_agg(distinct t.brick_title) filter (where t.brick_title is not null))[1:3] hints
      from public.product_taxonomy t
      group by t.item_group, t.item, t.sub_item
    )
    select
      g.item_group, g.item, g.sub_item,
      array_to_string(g.hints, ' · ') hint
    from target g
    where ${onlyMissing
      ? db`not exists (
            select 1 from public.item_keyword k
            where k.source = 'EXPERT'
              and k.item_group = g.item_group
              and coalesce(k.sub_item, k.item, '') = coalesce(g.sub_item, g.item, ''))`
      : db`exists (
            select 1 from public.item_keyword k
            where k.source = 'EXPERT'
              and k.item_group = g.item_group
              and coalesce(k.sub_item, k.item, '') = coalesce(g.sub_item, g.item, ''))`}
    order by g.item_group, g.item, g.sub_item
    ${opts.limit ? db`limit ${opts.limit}` : db``}
  `;

  return rows.map((r) => ({
    itemGroup: r.item_group,
    item: r.item,
    subItem: r.sub_item,
    hint: r.hint,
  }));
}

const label = (t: AliasTarget) => t.subItem || t.item || '';

/** 대상 한 묶음에 별칭을 만들어 받는다 */
export async function suggestAliases(targets: AliasTarget[]): Promise<AliasSuggestion[]> {
  if (targets.length === 0) return [];

  /*
    고정된 예시를 앞에, 이번에 물어보는 품목을 뒤에 둔다 (2026-09-08)

    예시 다섯 개는 묶음이 달라도 거의 같다(이름 순 고정). 앞에 두면 그 구간이 캐시에
    걸려 1/10 단가로 청구된다. 뒤에 두면 앞의 품목 목록이 매번 달라 캐시가 통째로
    빗나간다 — 같은 정보를 어느 순서로 놓느냐가 값을 가른다.
  */
  const user = [
    (await fewShot(targets)).replace(/^\n/, ''),
    '',
    '[검색어를 만들 법정 품목]',
    ...targets.map((t) => {
      const name = label(t);
      const parent = t.item && t.subItem && t.item !== t.subItem ? ` (상위: ${t.item})` : '';
      return `- ${name}${parent} [${t.itemGroup}]${t.hint ? ` · 참고 분류: ${t.hint}` : ''}`;
    }),
    '',
    'target 에는 위 목록의 이름을 그대로 적는다.',
  ].join('\n');

  const { value } = await structuredCall<{
    items: Array<{ target: string; keywords: string[]; note: string }>;
  }>({
    model: openaiConfig().rerankModel,
    system: SYSTEM,
    user,
    schemaName: 'item_aliases', purpose: 'alias',
    // 같은 이름이 두 번 들어가면 OpenAI 가 enum 을 거절한다. 묶음 안에 동명이 있을 수 있다
    schema: buildSchema([...new Set(targets.map(label))].filter((s) => s.length > 0)),
    effort: 'low',
  });

  const byName = new Map(targets.map((t) => [label(t), t]));
  const out: AliasSuggestion[] = [];
  // enum 으로 막았어도 세어 둔다. 조용히 사라지는 것이 이 자리에서 가장 알기 어려운 고장이다
  let dropped = 0;
  for (const it of value.items ?? []) {
    const target = byName.get(it.target?.trim() ?? '');
    // 목록에 없는 이름은 버린다. 지어낸 품목에 별칭이 붙으면 되짚을 수 없다
    if (!target) { dropped++; continue; }
    const seen = new Set<string>();
    const keywords = (it.keywords ?? [])
      .map((k) => (k ?? '').trim())
      .filter((k) => k.length >= 2 && k.length <= 30)
      .filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
    if (keywords.length) out.push({ target, keywords, note: it.note ?? '' });
  }
  if (dropped > 0) {
    console.warn(`검색어 생성 — 목록 밖 품목 ${dropped}건을 버렸습니다 (묶음 ${targets.length}종)`);
  }
  return out;
}

/** 제안을 사전에 담는다. 사람 것과 겹치면 넣지 않는다 */
export async function saveAliases(suggestions: AliasSuggestion[]): Promise<number> {
  const db = getDb();
  let saved = 0;
  for (const s of suggestions) {
    for (const k of s.keywords) {
      const [row] = await db<{ id: number }[]>`
        insert into public.item_keyword
          (item_group, item, sub_item, keyword, keyword_key, source, review_status, evidence)
        values (${s.target.itemGroup}, ${s.target.item}, ${s.target.subItem}, ${k},
                public.scope_term_key(${k}), 'LLM', 'auto_unreviewed', ${s.note})
        on conflict do nothing
        returning id
      `;
      if (row) saved++;
    }
  }
  return saved;
}
