import { getDb } from '../db';
import { embedBatch, structuredCall } from '../llm/client';
import { openaiConfig } from '../env';

/**
 * 품목 → 적용 기준, 뜻으로 찾기 (2026-09-04 추가)
 *
 * 왜 필요한가 — 실측으로 드러난 간극
 *   기존 경로는 두 가지였다. 등록 품목 이름·별칭 대조, 그리고 적용범위 원문의
 *   한국어 전문검색. 사고보고서 70건에 돌려 보니 품목이 붙은 것이 7건(10%)뿐이었다.
 *
 *   원인은 어휘다. 기준의 적용범위는 법령 용어를 쓰고 사고보고서는 일상 용어를 쓴다.
 *
 *     전기요       ← KC 60335-2-17 은 "전기 담요, 패드들, 의류" 라고 쓴다
 *     전기레인지    ← KC 60335-2-6 은 "거치형 조리레인지, 호브, 오븐" 이라고 쓴다
 *     전동킥보드    ← 부속서 72 는 "전동이륜평행차, 전동외륜보드" 라고 쓴다
 *
 *   설계문서 §5.2.1 이 조항 검색에서 지목한 간극("기준은 전도, 사고는 넘어짐")이
 *   품목 이름에서 똑같이 난다. 글자를 맞추는 방법으로는 넘을 수 없다.
 *
 * 왜 의미 검색만으로는 부족한가 — 이것도 재 봤다
 *   품목 이름을 임베딩해 적용범위와 견주니 1위 정확도가 5건 중 2건이었다.
 *   전기요는 10위였다. 품목 이름 하나는 신호가 너무 짧다.
 *
 *     전동킥보드  1위    가습기  1위    전기레인지  2위    전기매트  3위    전기요  10위
 *
 *   그런데 **상위 10위 안에는 5건 모두 들어왔다.** 그래서 이 저장소가 이미 쓰는
 *   방식을 그대로 쓴다 — 뜻으로 후보를 좁히고, 고르는 일은 모델에게 맡긴다
 *   (findAndVerifyGpc 와 같은 구조).
 *
 * 억지로 고르지 않는다
 *   확신이 낮으면 NONE 을 돌려준다. v0.7 §3.2 는 품목이 불명확하면 전 품목 검색을
 *   자동 실행하지 말라고 했다 — 틀린 품목을 붙이는 것은 안 붙이는 것보다 나쁘다.
 *   다른 제품의 시험이 섞인 목록을 담당자가 근거로 쓰게 되기 때문이다.
 */

const SYSTEM = [
  '당신은 한국 KC 안전기준의 적용범위를 읽고, 주어진 제품에 그 기준이 적용되는지 판정합니다.',
  '',
  '판정 규칙',
  '- 적용범위 원문에 그 제품이 포함되는지만 봅니다. 비슷해 보인다고 고르지 않습니다.',
  '- 기준은 법령 용어를 쓰고 사고보고서는 일상 용어를 씁니다.',
  '  "전기요"가 "전기 담요·패드"에 해당하는 것처럼, 말이 달라도 같은 물건이면 맞습니다.',
  '- 반대로 "전기매트"와 "침대 매트리스"처럼 이름만 닮고 물건이 다른 경우는 고르지 않습니다.',
  '- 확실하지 않으면 NONE 을 고릅니다. 틀린 기준을 붙이면 다른 제품의 시험이 섞입니다.',
].join('\n');

interface VerifyOutput {
  selected_standard_id: string;
  confidence_score: number;
  reasoning: string;
}

export interface SemanticScope {
  standardId: number;
  displayName: string;
  confidence: number;
  reasoning: string;
  /** 모델에게 보여 준 후보 수 — 감사에 남긴다 */
  candidateCount: number;
}

/** 후보를 몇 개까지 보여 줄 것인가. 실측상 정답이 10위 안에 들어왔다 */
const CANDIDATES = 12;

/** 이 아래면 붙이지 않는다. 틀린 품목은 안 붙인 것보다 나쁘다 */
const MIN_CONFIDENCE = 0.6;

const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/**
 * 품목 이름(과 있으면 사건 서술)으로 적용 기준 하나를 고른다.
 *
 * 사건 서술을 함께 넘기는 이유: 품목 이름은 짧아서 "전지"처럼 여러 기준에 걸리는
 * 말이 많다. 사고 상황이 있으면 어느 쪽인지 갈린다.
 */
export async function resolveScopeSemantically(
  itemName: string,
  narrative?: string | null,
): Promise<SemanticScope | null> {
  const db = getDb();

  const stds = await db<{ id: number; display_name: string; scope_text: string }[]>`
    select id, display_name, scope_text
    from public.standard
    where is_current and scope_text is not null and length(btrim(scope_text)) > 20
  `;
  if (stds.length === 0) return null;

  /*
    질의를 만든다.

    사건 서술을 통째로 넣지 않고 앞부분만 쓴다. 사고조사보고서는 접수번호·담당기관
    같은 머리말로 시작해서, 길게 넣으면 그 서식이 유사도를 지배한다.
  */
  const query = [itemName, (narrative ?? '').slice(0, 600)].filter(Boolean).join('\n');

  const [queryVec, ...scopeVecs] = await embedBatch([
    query,
    ...stds.map((s) => `${s.display_name}\n${s.scope_text.slice(0, 1500)}`),
  ]);

  const ranked = stds
    .map((s, i) => ({ ...s, sim: cosine(queryVec, scopeVecs[i]) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, CANDIDATES);

  const cfg = openaiConfig();
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['selected_standard_id', 'confidence_score', 'reasoning'],
    properties: {
      selected_standard_id: {
        type: 'string',
        enum: [...ranked.map((r) => String(r.id)), 'NONE'],
      },
      confidence_score: { type: 'number', description: '0.0~1.0 자기보고 확신도' },
      reasoning: { type: 'string', description: '적용범위의 어느 대목을 근거로 골랐는지 한두 문장' },
    },
  };

  const user = [
    '[제품]',
    itemName,
    narrative ? `\n[사고 상황]\n${narrative.slice(0, 600)}` : '',
    '',
    '[기준 후보 (뜻이 가까운 순)]',
    ranked
      .map((r) => `- id=${r.id} · ${r.display_name}\n  적용범위: ${r.scope_text.slice(0, 700).replace(/\s+/g, ' ')}`)
      .join('\n'),
  ].filter(Boolean).join('\n');

  const { value } = await structuredCall<VerifyOutput>({
    model: cfg.rerankModel,
    system: SYSTEM,
    user,
    schemaName: 'scope_verification',
    schema,
    effort: cfg.rerankEffort as Parameters<typeof structuredCall>[0]['effort'],
  });

  if (!value || value.selected_standard_id === 'NONE') return null;
  if (value.confidence_score < MIN_CONFIDENCE) return null;

  const picked = ranked.find((r) => String(r.id) === value.selected_standard_id);
  if (!picked) return null;

  return {
    standardId: Number(picked.id),
    displayName: picked.display_name,
    confidence: value.confidence_score,
    reasoning: value.reasoning,
    candidateCount: ranked.length,
  };
}
