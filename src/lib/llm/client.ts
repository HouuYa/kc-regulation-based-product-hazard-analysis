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
import { openaiConfig } from '../env';

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (client) return client;
  client = new OpenAI({ apiKey: openaiConfig().apiKey });
  return client;
}

/** reasoning 모델의 사고 강도. 값이 클수록 출력(=과금) 토큰이 늘어난다 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/**
 * 구조화 출력 호출 (§5.2.2 Structured Outputs)
 *
 * 자유 서술로 받고 나중에 파싱하는 방식과의 차이가 여기서 갈린다.
 *   - 형식 오류: 스키마가 강제되어 거의 없음
 *   - 코드 창작: 코드 목록을 enum 으로 고정하면 원천 차단
 *   - 필드 누락: required 지정으로 방지
 *
 * temperature 를 보내지 않는 이유 (실측으로 확인)
 *   GPT-5.6 계열은 temperature 를 지원하지 않는다. 0 을 보내면
 *   "does not support 0 with this model" 로 요청이 거부된다.
 *   대신 기본값이 1 이라 같은 입력에도 답이 흔들리므로, 반복 호출만으로
 *   일치도를 잴 수 있다(§5.2.3). 결정론적 태깅은 애초에 목표가 아니다 —
 *   태깅은 한 번 하고 저장하는 준비 단계이고, 재현성이 필요한 것은
 *   매칭(SQL)이다(§1.1 원칙 2).
 */
async function chatJsonCall<T>(args: {
  model: string;
  system: string;
  userContent: string | Array<Record<string, unknown>>;
  schemaName: string;
  schema: Record<string, unknown>;
  effort?: ReasoningEffort;
}): Promise<{ value: T; usage: CallUsage }> {
  const res = await getOpenAI().chat.completions.create({
    model: args.model,
    ...(args.effort ? { reasoning_effort: args.effort } : {}),
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: args.schemaName,
        strict: true,
        schema: args.schema,
      },
    },
  } as never);

  const content = res.choices[0]?.message?.content;
  if (!content) {
    throw new Error(`LLM(${args.model})이 빈 응답을 반환했습니다.`);
  }

  const u = res.usage;
  return {
    value: JSON.parse(content) as T,
    usage: {
      inputTokens: u?.prompt_tokens ?? 0,
      outputTokens: u?.completion_tokens ?? 0,
      reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

export async function structuredCall<T>(args: {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  effort?: ReasoningEffort;
}): Promise<{ value: T; usage: CallUsage }> {
  return chatJsonCall<T>({ ...args, userContent: args.user });
}

/**
 * 이미지가 섞인 구조화 출력 호출 (사고조사보고서 첨부 사진 분석용, §4.2 확장)
 *
 * Chat Completions 의 멀티모달 content 파트(`image_url`, data URI 허용)를 그대로 쓴다.
 * Storage 버킷이 비공개(§7.1)라 공개 URL을 못 주므로, 항상 base64 data URI로 보낸다.
 */
export async function structuredVisionCall<T>(args: {
  model: string;
  system: string;
  user: string;
  images: Array<{ dataUrl: string }>;
  schemaName: string;
  schema: Record<string, unknown>;
  effort?: ReasoningEffort;
}): Promise<{ value: T; usage: CallUsage }> {
  const userContent = [
    { type: 'text', text: args.user },
    ...args.images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
  ];
  return chatJsonCall<T>({ ...args, userContent });
}

/**
 * 임베딩 생성 (§4.2 L3)
 *
 * dimensions 를 명시하는 이유
 *   text-embedding-3-large 는 3072차원이 기본이지만, Matryoshka 표현이라
 *   1536 으로 잘라도 품질이 거의 유지된다(실측에서는 오히려 이 과제에서
 *   1536 쪽이 근소하게 나았다). 스키마가 vector(1536) 이므로 잘라서 받는다.
 *
 * 차원을 확인하는 이유
 *   모델을 바꿔 차원이 달라지면 삽입이 실패하는데, 그 실패가 배치 한복판에서
 *   나면 어디까지 처리됐는지 되짚기 어렵다. 첫 응답에서 바로 잡는다.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = openaiConfig();

  const res = await getOpenAI().embeddings.create({
    model: cfg.embeddingModel,
    input: texts,
    dimensions: cfg.embeddingDim,
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
