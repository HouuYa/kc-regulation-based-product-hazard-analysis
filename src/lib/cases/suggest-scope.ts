/**
 * 품목 → 적용기준 대응을 LLM 에게 제안받는다 (04 §5.4)
 *
 * 왜 필요한가 (2026-09-05 실측)
 *   사고보고서 71건 중 13건이 적용 기준을 못 찾아 분석이 시작조차 되지 않는다.
 *   그중 7건(54%)이 등기구 하나다 — LED등기구 5건, 할로겐등기구 2건.
 *
 *   기준이 없어서가 아니다. KC 60598-2-1·2-2·2-4 가 적재돼 있다. 그런데 그 세 기준에
 *   적용범위 원문도 품목명도 비어 있어서 품목 확정의 두 경로가 모두 막혔다.
 *   "LED등기구"라는 말과 "KC 60598-2-1"이라는 말을 이어 줄 것이 없는 것이다.
 *
 * 왜 LLM 인가
 *   이미 두 가지를 해 봤고 둘 다 이 자리에서 안 된다.
 *     품목명·별칭 일치   기준에 품목명이 비어 있어 맞출 대상이 없다
 *     적용범위 전문검색   적용범위 원문이 비어 있다
 *     의미 검색          위 둘의 재료가 없어 마찬가지로 못 찾는다
 *   남은 재료는 기준의 이름과 조항 제목뿐이다. "60598-2-1 고정형 범용 등기구"를 보고
 *   "LED등기구가 여기 해당한다"고 잇는 일은 지식이 필요하고, 그것이 LLM 의 자리다.
 *
 * 제안일 뿐 반영이 아니다
 *   review_status='auto_unreviewed' 로 넣는다. 담당자가 /terms 에서 확정해야 검색에
 *   쓰인다. 품목이 틀리면 엉뚱한 기준의 시험이 나오는데 그것은 조용히 틀리는 종류의
 *   고장이다 — 사람이 먼저 봐야 한다.
 */

import { getDb } from '../db';
import { structuredCall } from '../llm/client';
import { openaiConfig } from '../env';

export interface ScopeSuggestion {
  standardId: number;
  standardName: string;
  /** 왜 이 기준이라고 보는가 */
  reason: string;
  /** 0~1. 낮으면 담당자가 더 눈여겨봐야 한다 */
  confidence: number;
}

export interface SuggestOutcome {
  itemName: string;
  suggestions: ScopeSuggestion[];
  /** 모델이 "해당 기준이 없다"고 판단했다 — 비대상 품목일 수 있다 */
  none: boolean;
  note: string;
}

const SYSTEM = [
  '너는 한국 제품안전 담당자를 돕는다. 사고보고서의 품목명에 어떤 KC 안전기준이 적용되는지 고른다.',
  '',
  '지켜야 할 것',
  '- 주어진 목록에 있는 기준만 고른다. 목록에 없는 기준명을 지어내지 않는다.',
  '- 확신이 없으면 confidence 를 낮게 준다. 억지로 고르지 않는다.',
  '- 해당하는 기준이 목록에 없으면 빈 목록을 돌려주고 note 에 이유를 적는다.',
  '  안전관리 대상이 아닌 품목(예: "비대상")이면 그렇게 적는다.',
  '- 하나만 고르지 않아도 된다. 형태에 따라 여러 기준이 걸릴 수 있으면 모두 고른다.',
  '  예: 등기구는 설치 형태(고정형·매입형·이동형)에 따라 적용 기준이 갈린다.',
  '- reason 은 한 문장으로 짧게 쓴다. 담당자가 확정·반려를 판단할 근거다.',
].join('\n');

/**
 * 고를 대상을 id 목록으로 못박는다 (2026-09-08)
 *
 * 전에는 `display_name` 을 자유 문자열로 받고, 목록에 없는 이름이면 코드에서 버렸다.
 * 프롬프트로 "지어내지 마라"라고 이르는 것과, 스키마가 **지어낼 수 없게** 만드는 것은
 * 다르다. 실제로 버려진 답이 몇 건인지 아무도 세지 않아, 이름을 살짝 다르게 적어
 * 통째로 사라진 제안이 있어도 드러나지 않았다.
 *
 * 이 저장소의 다른 아홉 자리는 이미 id enum 으로 고정돼 있다(rerank·scope_semantic·
 * gpc_verify·taxonomy_link …). 여기만 예외였다.
 *
 * id 를 문자열로 쓰는 이유는 OpenAI 가 integer 타입의 enum 을 거절하기 때문이다
 * (rerank.ts 에 같은 주석이 있다 — "enum value 6070 does not validate against
 * {'type': 'integer'}").
 */
function buildSchema(ids: number[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      standards: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            standard_id: { type: 'string', enum: ids.map(String) },
            reason: { type: 'string', description: '왜 이 기준인지 한 문장. 담당자가 확정·반려를 판단할 근거다' },
            confidence: { type: 'number', description: '0.0~1.0 자기보고 확신도' },
          },
          required: ['standard_id', 'reason', 'confidence'],
        },
      },
      note: { type: 'string', description: '고른 것이 없으면 그 이유. 비대상 품목이면 그렇게 적는다' },
    },
    required: ['standards', 'note'],
  } as const;
}

/**
 * 기준 목록을 LLM 에게 보여 줄 형태로 만든다.
 *
 * 적용범위 원문이 비어 있는 기준이 많으므로(등기구가 그렇다) 조항 제목 몇 개를
 * 함께 보낸다. "고정형 범용 등기구에 대한 개별 요구사항" 같은 제목이 사실상
 * 적용범위 구실을 한다.
 */
async function standardCatalog(): Promise<Array<{ id: number; name: string; line: string }>> {
  const rows = await getDb()<{
    id: number; display_name: string; item_name: string | null;
    cert_scheme: string | null; scope_text: string | null; titles: string[] | null;
  }[]>`
    select s.id, s.display_name, s.item_name, s.cert_scheme,
           left(s.scope_text, 160) scope_text,
           (select array_agg(t order by t)
              from (select distinct nullif(trim(c.title_raw), '') t
                      from public.clause c
                     where c.standard_id = s.id and c.title_raw is not null
                     limit 6) x) titles
    from public.standard s
    where s.is_current
    order by s.display_name
  `;

  return rows.map((r) => ({
    id: r.id,
    name: r.display_name,
    line: [
      r.display_name,
      r.item_name ? `품목: ${r.item_name}` : '',
      r.cert_scheme ? `구분: ${r.cert_scheme}` : '',
      r.scope_text ? `적용범위: ${r.scope_text.replace(/\s+/g, ' ')}` : '',
      r.titles?.length ? `조항: ${r.titles.slice(0, 6).join(' / ')}` : '',
    ].filter(Boolean).join(' · '),
  }));
}

/** 품목명 하나에 대해 적용 기준을 제안받는다 */
export async function suggestScope(
  itemName: string,
  narrative: string | null,
  catalog?: Awaited<ReturnType<typeof standardCatalog>>,
): Promise<SuggestOutcome> {
  const list = catalog ?? (await standardCatalog());

  const user = [
    `[품목명] ${itemName}`,
    narrative ? `[사고 서술] ${narrative.replace(/\s+/g, ' ').slice(0, 600)}` : '',
    '',
    '[고를 수 있는 기준 목록] — standard_id 로 답한다',
    ...list.map((s) => `- [${s.id}] ${s.line}`),
  ].filter(Boolean).join('\n');

  const { value: res } = await structuredCall<{
    standards: Array<{ standard_id: string; reason: string; confidence: number }>;
    note: string;
  }>({
    model: openaiConfig().rerankModel,
    system: SYSTEM,
    user,
    schemaName: 'scope_suggestion', purpose: 'scope_suggest',
    schema: buildSchema(list.map((s) => s.id)),
    effort: 'low',
  });

  const byId = new Map(list.map((s) => [Number(s.id), s.name]));
  const suggestions: ScopeSuggestion[] = [];
  // enum 이 뚫리는 일은 없어야 하지만, 뚫렸을 때 조용히 사라지지 않도록 세어서 알린다
  let dropped = 0;
  for (const s of res.standards ?? []) {
    const id = Number(s.standard_id);
    const name = byId.get(id);
    if (!name) { dropped++; continue; }
    suggestions.push({
      standardId: id,
      standardName: name,
      reason: s.reason,
      confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)),
    });
  }
  if (dropped > 0) {
    console.warn(`품목 기준 제안 — 목록 밖 기준 ${dropped}건을 버렸습니다 ("${itemName}")`);
  }

  return {
    itemName,
    suggestions,
    none: suggestions.length === 0,
    note: res.note ?? '',
  };
}

/**
 * 제안을 용어 사전에 담는다.
 *
 * 이미 같은 (용어, 기준) 줄이 있으면 건드리지 않는다 — 담당자가 이미 확정했거나
 * 반려한 것을 LLM 제안이 덮어쓰면 사람의 판단이 사라진다.
 */
export async function saveSuggestions(
  itemName: string,
  suggestions: ScopeSuggestion[],
): Promise<number> {
  if (suggestions.length === 0) return 0;
  const db = getDb();
  let saved = 0;

  for (const s of suggestions) {
    // term_key 는 DB 함수로 만든다. 여기서 따로 정규화하면 조회 쪽과 어긋나
    // "LED 등기구"와 "LED등기구"가 다른 용어가 된다
    const [row] = await db<{ id: number }[]>`
      insert into public.scope_term (term, term_key, standard_id, source, evidence, confidence, review_status)
      values (${itemName}, public.scope_term_key(${itemName}), ${s.standardId},
              'LLM', ${s.reason}, ${s.confidence}, 'auto_unreviewed')
      on conflict (term_key, standard_id) do nothing
      returning id
    `;
    if (row) saved++;
  }
  return saved;
}
