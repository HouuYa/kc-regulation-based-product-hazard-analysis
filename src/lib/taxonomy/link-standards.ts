/**
 * 법정 품목 → KC안전기준 잇기 (049)
 *
 * 무엇을 푸는가
 *   검색어 사전이 "LED등기구"를 법정 품목 「조명기기 > 일반조명기구 > LED등기구」까지
 *   데려다주는데, 거기서 기준으로 넘어가지 못했다.
 *
 * 왜 글자로는 안 되나 (실측)
 *   법정 품목명으로 적용범위를 전문검색하니 187종 중 7종(4%)만 걸렸다. 부분 문자열까지
 *   허용해도 11종이다.
 *
 *     법정 품목  "모발건조기"                        고시의 말
 *     적용범위   "피부 또는 모발을 손질하기 위한 전기기기"    기준의 말
 *
 * 어떻게 하나 — 이미 쓰는 방식 그대로
 *   뜻으로 후보를 좁히고, 고르는 일은 모델에게 맡긴다(scope-semantic.ts·findAndVerifyGpc
 *   와 같은 구조). 다른 점은 **사건마다 런타임으로 돌지 않고 품목 목록에 미리 한 번**
 *   돌아 결과를 담아 둔다는 것이다. 한 번 확정하면 그 품목으로 이어지는 모든 사고·리콜에
 *   재사용된다.
 *
 * 억지로 고르지 않는다
 *   확신이 낮으면 NONE 을 돌려준다. 틀린 기준을 붙이는 것은 안 붙이는 것보다 나쁘다 —
 *   다른 제품의 시험이 섞인 목록을 담당자가 근거로 쓰게 된다(v0.7 §3.2).
 */

import { getDb } from '../db';
import { structuredCall, embedBatch } from '../llm/client';
import { openaiConfig } from '../env';

/** 한 품목에 후보를 몇 개까지 보여 줄 것인가 */
const CANDIDATES = 8;

/** 한 번에 몇 품목을 물을 것인가. 크게 묶을수록 싸지만 프롬프트가 길어져 답이 흐려진다 */
export const BATCH = 10;

export interface LinkTarget {
  itemGroup: string;
  item: string | null;
  subItem: string | null;
  /** 이 품목이 무엇인지 알려 줄 참고 — GPC 이름 */
  hint: string | null;
}

export interface LinkSuggestion {
  target: LinkTarget;
  standardId: number;
  standardName: string;
  confidence: number;
  evidence: string;
}

export interface LinkOutcome {
  suggestions: LinkSuggestion[];
  /** 후보는 있었으나 모델이 고르지 않은 품목 */
  declined: Array<{ target: LinkTarget; reason: string }>;
}

const SYSTEM = [
  '너는 한국 KC 안전기준의 적용범위를 읽고, 주어진 법정 품목에 그 기준이 적용되는지 판정한다.',
  '',
  '판정 규칙',
  '- **적용범위 원문에 근거가 있어야만** 고른다. 이름이 비슷하다는 이유로 고르지 않는다.',
  '- 적용범위는 법령 용어를 쓰고 품목명은 고시 용어를 쓴다. 글자가 달라도 같은 물건이면 고른다.',
  '  예: 「모발건조기」와 "피부 또는 모발을 손질하기 위한 전기기기"는 같은 것을 가리킨다.',
  '- 하나만 고른다. 여러 기준이 걸릴 것 같으면 가장 직접적인 것 하나만 고르고,',
  '  나머지는 reasoning 에 적는다.',
  '- **확신이 없으면 NONE 을 고른다.** 틀린 기준을 붙이는 것은 안 붙이는 것보다 나쁘다.',
  '- reasoning 에는 적용범위의 어느 대목을 근거로 보았는지 짧게 적는다.',
  '  담당자가 확정·반려를 판단하는 재료다.',
].join('\n');

/** 이을 대상을 고른다 */
export async function linkTargets(opts: {
  itemGroup?: string;
  onlyMissing?: boolean;
  limit?: number;
} = {}): Promise<LinkTarget[]> {
  const db = getDb();
  const onlyMissing = opts.onlyMissing ?? true;

  const rows = await db<{
    item_group: string; item: string | null; sub_item: string | null; hint: string | null;
  }[]>`
    with target as (
      select
        t.item_group, t.item, t.sub_item,
        array_to_string((array_agg(distinct t.brick_title)
          filter (where t.brick_title is not null))[1:3], ' · ') hint
      from public.product_taxonomy t
      where ${opts.itemGroup ? db`t.item_group = ${opts.itemGroup}` : db`true`}
      group by t.item_group, t.item, t.sub_item
    )
    select g.item_group, g.item, g.sub_item, g.hint
    from target g
    where ${onlyMissing
      ? db`not exists (
            select 1 from public.taxonomy_standard x
            where x.item_group = g.item_group
              and coalesce(x.sub_item, '') = coalesce(g.sub_item, '')
              and coalesce(x.item, '') = coalesce(g.item, ''))`
      : db`true`}
    order by g.item_group, g.item, g.sub_item
    ${opts.limit ? db`limit ${opts.limit}` : db``}
  `;

  return rows.map((r) => ({
    itemGroup: r.item_group, item: r.item, subItem: r.sub_item, hint: r.hint || null,
  }));
}

const label = (t: LinkTarget) => t.subItem || t.item || '';

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * 한 묶음을 이어 본다.
 *
 * 품목마다 자기 후보 목록이 다르므로, 한 프롬프트 안에서 품목별로 후보를 따로 적어 준다.
 */
export async function suggestLinks(targets: LinkTarget[]): Promise<LinkOutcome> {
  if (targets.length === 0) return { suggestions: [], declined: [] };
  const db = getDb();

  // 미리 계산해 둔 적용범위 임베딩을 쓴다(048). 없으면 이 품목은 건너뛴다 —
  // 여기서 그때그때 임베딩하면 배치가 느려지고 비용도 는다
  const stds = await db<{
    id: number; display_name: string; title_ko: string | null;
    scope_text: string | null; scope_embedding: string;
  }[]>`
    select id, display_name, title_ko, scope_text, scope_embedding::text
    from public.standard
    where is_current and scope_embedding is not null
  `;
  if (stds.length === 0) throw new Error('적용범위 임베딩이 없습니다. npm run scopes:embed 를 먼저 돌리세요.');

  const scopeVecs = stds.map((s) => JSON.parse(s.scope_embedding) as number[]);

  // 품목 이름 하나는 신호가 짧다. 상위 품목과 GPC 이름을 함께 넣어 뜻을 두껍게 한다
  const queries = targets.map((t) =>
    [label(t), t.item && t.item !== label(t) ? t.item : '', t.hint ?? '']
      .filter(Boolean).join('\n'),
  );
  const queryVecs = await embedBatch(queries);

  const perTarget = targets.map((t, i) => ({
    target: t,
    ranked: stds
      .map((s, j) => ({ s, sim: cosine(queryVecs[i], scopeVecs[j]) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, CANDIDATES),
  }));

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['target', 'selected_standard_id', 'confidence_score', 'reasoning'],
          properties: {
            target: { type: 'string' },
            selected_standard_id: { type: 'string' },
            confidence_score: { type: 'number' },
            reasoning: { type: 'string' },
          },
        },
      },
    },
  } as const;

  const user = perTarget.map(({ target, ranked }) => [
    `[품목] ${label(target)}${target.item && target.item !== label(target) ? ` (상위: ${target.item})` : ''} · ${target.itemGroup}`,
    target.hint ? `참고 분류: ${target.hint}` : '',
    '후보:',
    /*
      적용범위가 없는 기준은 제목만 보여 준다.

      등기구 3종(KC 60598-2-1·2-2·2-4)이 그렇다. 적용범위가 0자인데 제목은
      "제2-1부: 고정형 등기구-개별요구사항" 처럼 어느 품목인지 분명히 말해 준다.
      "적용범위: (없음)" 처럼 빈 줄을 보이면 모델이 근거가 없다고 보고 NONE 을 고른다.
    */
    ...ranked.map((r) => {
      const scope = (r.s.scope_text ?? '').replace(/\s+/g, ' ').trim();
      const head = `  id=${r.s.id} ${r.s.display_name}${r.s.title_ko ? ` — ${r.s.title_ko}` : ''}`;
      return scope.length > 20
        ? `${head}\n    적용범위: ${scope.slice(0, 320)}`
        : `${head}\n    (적용범위 원문이 없습니다. 위 제목으로 판단하세요)`;
    }),
    '  id=NONE 해당하는 기준이 후보에 없음',
  ].filter(Boolean).join('\n')).join('\n\n');

  const { value } = await structuredCall<{
    items: Array<{ target: string; selected_standard_id: string; confidence_score: number; reasoning: string }>;
  }>({
    model: openaiConfig().rerankModel,
    system: SYSTEM,
    user: `${user}\n\ntarget 에는 위 [품목] 의 이름을 그대로 적는다.`,
    schemaName: 'taxonomy_standard_links',
    schema,
    effort: 'low',
  });

  const byName = new Map(targets.map((t) => [label(t), t]));
  /*
    id 를 숫자로 씻어서 담는다.

    postgres.js 는 bigint 를 **문자열**로 준다. 씻지 않으면 Set·Map 대조가 전부
    빗나가고, 모델이 옳게 고른 것을 "보여 준 적 없는 기준"이라며 버린다.
    실제로 처음에 A/V신호수신기·비디오카메라가 전부 그렇게 버려졌다
    (eval.ts 가 재현율 0% 로 겪었던 것과 같은 함정이다).
  */
  const stdName = new Map(stds.map((s) => [Number(s.id), s.display_name]));

  /*
    허용 집합은 **묶음 전체**로 잡는다.

    품목마다 자기 후보만 허용하면, 모델이 다른 품목 후보에서 본 기준을 옳게 가져다
    쓴 경우를 버리게 된다. 지어낸 기준을 막는다는 목적에는 묶음 단위로 충분하다 —
    프롬프트에 한 번도 보이지 않은 기준은 여전히 버린다.
  */
  const shown = new Set(perTarget.flatMap(({ ranked }) => ranked.map((r) => Number(r.s.id))));

  const suggestions: LinkSuggestion[] = [];
  const declined: LinkOutcome['declined'] = [];

  for (const it of value.items ?? []) {
    const target = byName.get((it.target ?? '').trim());
    if (!target) continue;

    if (!it.selected_standard_id || it.selected_standard_id === 'NONE') {
      declined.push({ target, reason: it.reasoning ?? '' });
      continue;
    }
    const id = Number(it.selected_standard_id);
    // 묶음에 한 번도 보이지 않은 기준은 버린다. 지어낸 것이기 때문이다
    if (!shown.has(id)) {
      declined.push({ target, reason: `보여 준 적 없는 기준(id=${it.selected_standard_id})을 골라 버렸습니다` });
      continue;
    }
    suggestions.push({
      target,
      standardId: id,
      standardName: stdName.get(id) ?? String(id),
      confidence: Math.max(0, Math.min(1, Number(it.confidence_score) || 0)),
      evidence: it.reasoning ?? '',
    });
  }
  return { suggestions, declined };
}

/** 제안을 담는다. 이미 있는 대응은 건드리지 않는다 — 담당자의 판단을 덮지 않는다 */
export async function saveLinks(suggestions: LinkSuggestion[]): Promise<number> {
  const db = getDb();
  let saved = 0;
  for (const s of suggestions) {
    const [row] = await db<{ id: number }[]>`
      insert into public.taxonomy_standard
        (item_group, item, sub_item, standard_id, source, review_status, confidence, evidence)
      values (${s.target.itemGroup}, ${s.target.item}, ${s.target.subItem}, ${s.standardId},
              'SEMANTIC_LLM', 'auto_unreviewed', ${s.confidence}, ${s.evidence})
      on conflict do nothing
      returning id
    `;
    if (row) saved++;
  }
  return saved;
}
