/**
 * HyDE — 가상 조항을 지어내 의미 검색의 질의로 쓴다 (04-2 §2.2)
 *
 * 왜 필요한가
 *   사고 서술과 기준 조항은 문체가 아예 다르다. 같은 일을 말하는데 겹치는 낱말이 없다.
 *
 *     사고 서술   "가습기를 켜 두고 자는데 타는 냄새가 나서 보니 불이 붙어 있었다"
 *     기준 조항   "이상운전 시 온도 상승은 표 9에서 정한 값을 초과하여서는 안 된다"
 *
 *   의미 검색은 이 둘을 가깝다고 보지 않는다. 진단에서 정답 조항의 49%가 "찾기는
 *   하는데 상위 20 밖으로 밀린" 상태였는데, 문체 차이가 그 원인의 하나로 보인다.
 *
 * 무엇을 하는가
 *   사고 서술로 **답에 해당할 법한 조항 문단을 LLM 이 지어내고**, 그 문단을 임베딩해
 *   의미 갈래의 질의로 쓴다. 질의-문서 비교가 문서-문서 비교로 바뀐다.
 *
 * 지어낸 글은 검색에만 쓰고 어디에도 남기지 않는다
 *   이 문단은 실재하는 조항이 아니다. 담당자에게 보이거나 저장되면 "기준에 이런 조항이
 *   있다"로 오해될 수 있다. 임베딩을 만드는 재료로만 쓰고 버린다.
 *
 * 다른 갈래는 건드리지 않는다
 *   코드 갈래는 여전히 HF·DT 로, 어휘 갈래는 여전히 사고 원문의 낱말로 찾는다.
 *   의미 갈래 하나만 바꾸므로 나머지 성적을 망가뜨리지 않는다.
 */

import { structuredCall, embedBatch } from '../llm/client';
import { openaiConfig } from '../env';

const SYSTEM = [
  '너는 한국 제품안전 기준의 조항을 쓰는 사람이다.',
  '사고 서술을 읽고, 이 사고와 관련될 만한 **안전기준 조항의 본문**을 지어낸다.',
  '',
  '지켜야 할 것',
  '- 기준 조항의 문체로 쓴다. "…하여서는 안 된다", "…를 측정하여 판정한다" 같은 투다.',
  '- 사고 이야기를 다시 쓰지 않는다. 그 사고를 다룰 **요구사항과 시험**을 쓴다.',
  '- 실제 조항 번호나 표 번호를 지어내지 않는다. 번호 없이 요구사항 자체만 쓴다.',
  '- 3~5문장. 짧게.',
  '- 하나의 원인만 고르지 말고, 그 피해를 낼 수 있는 여러 요구사항을 함께 적는다.',
].join('\n');

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: { clause: { type: 'string' } },
  required: ['clause'],
} as const;

export interface HydeOutcome {
  /** 지어낸 조항 문단. 화면에 보이지 않는다 — 되짚기 위해 돌려줄 뿐이다 */
  text: string;
  /** 그 문단의 임베딩. 의미 갈래의 질의로 쓴다 */
  embedding: number[];
}

/**
 * 사고 서술로 가상 조항을 만들고 임베딩까지 돌려준다.
 *
 * 실패하면 던진다. 부르는 쪽이 원래 임베딩으로 되돌아가면 된다 — HyDE 는 의미 갈래를
 * 다듬는 단계이지 후보를 만드는 단계가 아니다.
 */
export async function hydeQuery(input: {
  itemName: string | null;
  narrative: string;
  hfCodes: string[];
  dtCodes: string[];
  /** 어느 사건인가. 기록에 남긴다(054) */
  caseId?: number | null;
}): Promise<HydeOutcome> {
  const user = [
    input.itemName ? `[품목] ${input.itemName}` : '',
    `[사고 서술] ${input.narrative.replace(/\s+/g, ' ').slice(0, 1200)}`,
    input.dtCodes.length ? `[피해유형] ${input.dtCodes.join(', ')}` : '',
    input.hfCodes.filter((c) => c !== 'HF.UNKNOWN').length
      ? `[확인된 원인] ${input.hfCodes.filter((c) => c !== 'HF.UNKNOWN').join(', ')}`
      : '[확인된 원인] 없음 — 원인이 밝혀지지 않은 사고다',
  ].filter(Boolean).join('\n');

  const { value } = await structuredCall<{ clause: string }>({
    model: openaiConfig().rerankModel,
    system: SYSTEM,
    user,
    schemaName: 'hypothetical_clause', purpose: 'hyde', caseId: input.caseId,
    schema,
    effort: 'low',
  });

  const text = (value.clause ?? '').trim();
  if (!text) throw new Error('가상 조항이 비어 있습니다.');

  const [embedding] = await embedBatch([text]);
  return { text, embedding };
}
