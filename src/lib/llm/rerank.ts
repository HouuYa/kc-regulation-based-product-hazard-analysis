/**
 * L3.5 정밀 재채점 — 리랭킹 (설계문서 §5.6)
 *
 * 넓게 건진 뒤 좁게 추린다.
 *   검색 단계(①~④)는 놓치지 않는 것이 목표(재현율)
 *   이 단계는 틀린 것을 걸러내는 것이 목표(정밀도)
 *
 * 검색이 세부 구분에 약한 이유: 벡터는 문장을 한 덩어리 숫자로 압축하므로
 * "본체 전도"와 "발판 전도" 같은 좁은 차이가 뭉개진다. 리랭커는 질의와 후보를
 * 한 쌍으로 놓고 처음부터 같이 읽어 다시 채점한다.
 *
 * 반드시 지키는 규칙 (§5.6.3)
 *   - 후보를 새로 만들지 못한다. 후보 ID 를 enum 으로 묶어 목록 밖 응답을 구조적으로 차단.
 *     근거 없는 조항이 시험 항목 목록에 끼어드는 것을 원천 봉쇄한다.
 *   - 점수·이유·모델명을 저장한다. 화면은 저장본을 보여 주므로 담당자에게는 항상 같은 결과다.
 *   - 탈락 건도 남긴다. 사각지대 분석에서 "검색에는 걸렸으나 관련성이 낮았던" 이력이 필요하다.
 *
 * 재현성에 관한 정직한 표기 (v0.7 §3.4·§7.6)
 *   LLM 리랭킹 결과를 저장하면 "결과 보존"은 되지만 "동일 재실행"이 보장되지는 않는다.
 *   둘은 다른 것이므로 화면에 그렇게 표시해야 한다.
 *
 * 0단계에서의 위치 (v0.7 §7.6)
 *   0A·0B 의 필수 구성요소가 아니다. 코드+어휘+의미 검색의 상위 후보가 너무 넓을 때
 *   0C 에서 켜고 비교한다. match_run.use_rerank 스위치가 그 실험을 위한 것이다.
 */

import { structuredCall } from './client.js';

export interface RerankCandidate {
  clauseId: number;
  marker: string;
  contextHeader: string | null;
  body: string;
  testConditions?: string[];
}

export interface RerankScore {
  clause_id: number;
  relevance: number;
  reason: string;
}

const SYSTEM = `당신은 제품 사고와 안전기준 조항의 관련성을 재채점하는 심사자다.

규칙
- 주어진 후보 목록에 있는 조항만 채점한다. 목록에 없는 조항을 추가하지 않는다.
- relevance 는 0.0~1.0. "이 사고를 확인하려면 이 조항의 시험을 해야 하는가"를 기준으로 매긴다.
- 같은 위해요인이라도 적용 부위·조건이 다르면 낮게 준다.
  예: 의자 본체의 전도와 발판의 전도는 다른 시험이다.
- reason 은 한 문장으로, 무엇이 일치하고 무엇이 어긋나는지 짚는다.
  "관련 있음" 같은 동어반복은 쓰지 않는다.
- 위반 여부를 판정하지 않는다. 관련성만 매긴다.`;

/**
 * 후보 15~20건을 사건과 함께 넘겨 재채점한다.
 *
 * 후보가 많지 않은 이유: 리랭커는 느리다. 수십 건이 한계다.
 * "20만 권을 다 펼칠 수는 없으니 서가에서 20권을 뽑아 온 뒤 목차를 확인한다."
 */
export async function rerankCandidates(
  query: { itemName: string | null; narrative: string; hfCodes: string[]; dtCodes: string[] },
  candidates: RerankCandidate[],
  model: string,
): Promise<RerankScore[]> {
  if (candidates.length === 0) return [];

  const allowedIds = candidates.map((c) => c.clauseId);

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['scores'],
    properties: {
      scores: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['clause_id', 'relevance', 'reason'],
          properties: {
            // 후보 ID 를 enum 으로 못박는다 — 목록 밖 조항은 구조적으로 나올 수 없다
            clause_id: { type: 'integer', enum: allowedIds },
            relevance: { type: 'number' },
            reason: { type: 'string' },
          },
        },
      },
    },
  };

  const user = [
    '[사건]',
    query.itemName ? `품목: ${query.itemName}` : '',
    `서술: ${query.narrative}`,
    `위해요인 코드: ${query.hfCodes.join(', ') || '(없음)'}`,
    `피해유형 코드: ${query.dtCodes.join(', ') || '(없음)'}`,
    '',
    '[후보 조항]',
    ...candidates.map((c) =>
      [
        `--- clause_id=${c.clauseId} (${c.marker})`,
        c.contextHeader ?? '',
        c.body,
        c.testConditions?.length ? `시험조건: ${c.testConditions.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ]
    .filter(Boolean)
    .join('\n');

  const res = await structuredCall<{ scores: RerankScore[] }>({
    model,
    system: SYSTEM,
    user,
    schemaName: 'rerank_scores',
    schema,
    temperature: 0,
  });

  // 스키마를 통과했더라도 한 번 더 거른다. enum 이 뚫리는 일은 없어야 하지만,
  // "후보를 새로 만들지 못한다"는 규칙은 두 겹으로 지킨다.
  const allowed = new Set(allowedIds);
  return res.scores
    .filter((s) => allowed.has(s.clause_id))
    .map((s) => ({ ...s, relevance: Math.min(1, Math.max(0, s.relevance)) }));
}
