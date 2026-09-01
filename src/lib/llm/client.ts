/**
 * OpenAI 클라이언트 — 태깅·임베딩·리랭킹의 공통 입구
 *
 * 설계문서 §4.1 이 정한 LLM 사용 지점은 여섯 곳이고, 그 밖에서는 쓰지 않는다.
 * 특히 "어떤 조항이 걸리는가"는 SQL 이 계산한다(원칙 2). 이 파일은 번역만 맡는다.
 *
 * 모델 ID 를 환경변수로 빼는 이유
 *   모델은 자주 바뀌고, 바꾸면 결과도 바뀐다. 코드에 박아 두면 어떤 모델로 만든
 *   태깅인지 나중에 알 수 없다. 그래서 실행할 때마다 모델명을 받아 결과에 함께
 *   저장한다(clause_tag.tagging_model, clause.embedding_model).
 */

import OpenAI from 'openai';
import { openaiConfig } from '../env.js';

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (client) return client;
  client = new OpenAI({ apiKey: openaiConfig().apiKey });
  return client;
}

/**
 * 구조화 출력 호출 (§5.2.2 Structured Outputs)
 *
 * 자유 서술로 받고 나중에 파싱하는 방식과의 차이가 여기서 갈린다.
 *   - 형식 오류: 스키마가 강제되어 거의 없음
 *   - 코드 창작: 코드 목록을 enum 으로 고정하면 원천 차단
 *   - 필드 누락: required 지정으로 방지
 *
 * strict: true 를 쓰면 스키마를 벗어난 출력이 아예 나오지 않는다.
 */
export async function structuredCall<T>(
  args: {
    model: string;
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
    /** 반복 호출로 일치도를 잴 때는 0 이 아니어야 답이 흔들린다(§5.2.3) */
    temperature?: number;
  },
): Promise<T> {
  const res = await getOpenAI().chat.completions.create({
    model: args.model,
    temperature: args.temperature ?? 0,
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: args.schemaName,
        strict: true,
        schema: args.schema,
      },
    },
  });

  const content = res.choices[0]?.message?.content;
  if (!content) {
    throw new Error('LLM 이 빈 응답을 반환했습니다.');
  }
  return JSON.parse(content) as T;
}

/**
 * 임베딩 생성 (§4.2 L3)
 *
 * 차원을 확인하는 이유: 스키마가 vector(1536) 으로 고정되어 있다.
 * 모델을 바꿔 차원이 달라지면 삽입이 실패하는데, 그 실패가 배치 한복판에서
 * 나면 어디까지 처리됐는지 되짚기 어렵다. 첫 응답에서 바로 잡는다.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = openaiConfig();

  const res = await getOpenAI().embeddings.create({
    model: cfg.embeddingModel,
    input: texts,
  });

  const vectors = res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);

  const dim = vectors[0]?.length ?? 0;
  if (dim !== cfg.embeddingDim) {
    throw new Error(
      `임베딩 차원이 맞지 않습니다: 모델 ${cfg.embeddingModel} 이 ${dim}차원을 반환했으나 ` +
        `스키마는 vector(${cfg.embeddingDim}) 입니다.\n` +
        `모델을 바꾸려면 OPENAI_EMBEDDING_DIM 과 DB 컬럼 타입을 함께 바꾸고 전량 재생성해야 합니다(§2.2).`,
    );
  }
  return vectors;
}
