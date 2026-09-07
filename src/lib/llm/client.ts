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
import { openaiConfig, assertEmbeddingDim } from '../env';

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
 * 호출을 부른 자리. 화면이 이 값으로 묶어 "어디에 얼마 썼나"를 보여 준다(052).
 *
 * 문자열을 아무렇게나 받지 않고 목록으로 묶는 이유는, 오타 하나로 같은 단계가
 * 두 줄로 갈라져 집계가 조용히 틀어지기 때문이다.
 */
export type LlmPurpose =
  | 'tagging'        // 사건·조항에 HF·DT 코드 부여
  | 'rerank'         // 조항 후보 재채점
  | 'hyde'           // 가상 조항 생성
  | 'scope_semantic' // 적용범위 의미검색으로 기준 고르기
  | 'scope_filter'   // 원문검색 후보 거르기
  | 'scope_suggest'  // 품목에 맞는 기준 제안
  | 'gpc_verify'     // GPC 계위 검증
  | 'alias'          // 법정 품목의 일상어 별칭 생성
  | 'taxonomy_link'  // 법정 품목 → 기준 잇기
  | 'embedding';     // 임베딩

/**
 * 호출 한 건을 남긴다 (052)
 *
 * 기록에 실패해도 본 작업은 계속한다. 비용을 못 적는 것보다 처리가 멈추는 편이
 * 훨씬 나쁘다 — 기록은 곁다리다.
 *
 * DB 를 여기서 직접 부르지 않고 늦게 불러오는(dynamic import) 이유는, 이 파일이
 * 스크립트·서버 양쪽에서 쓰이는데 db 모듈을 위에서 정적으로 물면 임포트 고리가
 * 생기기 때문이다.
 */
async function recordCall(row: {
  purpose: LlmPurpose;
  model: string;
  usage: CallUsage;
  itemCount?: number;
  ok?: boolean;
  error?: string | null;
}): Promise<void> {
  try {
    const { getDb } = await import('../db');
    await getDb()`
      insert into public.llm_call
        (purpose, model, input_tokens, output_tokens, reasoning_tokens, item_count, ok, error)
      values (${row.purpose}, ${row.model},
              ${row.usage.inputTokens}, ${row.usage.outputTokens}, ${row.usage.reasoningTokens},
              ${row.itemCount ?? 1}, ${row.ok ?? true}, ${row.error ?? null})
    `;
  } catch (e) {
    console.warn('AI 호출 기록 실패(처리는 계속합니다):', e instanceof Error ? e.message : e);
  }
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
  purpose?: LlmPurpose;
}): Promise<{ value: T; usage: CallUsage }> {
  let res;
  try {
    res = await getOpenAI().chat.completions.create({
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
  } catch (e) {
    // 실패해도 입력 토큰은 이미 나갔다. 다만 응답이 없으므로 토큰 수를 알 수 없다 —
    // 0 으로 남기되 실패였음을 표시해, 성공만 세다 실제 지출과 어긋나는 것을 막는다
    if (args.purpose) {
      await recordCall({
        purpose: args.purpose,
        model: args.model,
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
      });
    }
    throw e;
  }

  const u = res.usage;
  const usage: CallUsage = {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
  };

  const content = res.choices[0]?.message?.content;
  if (!content) {
    if (args.purpose) {
      await recordCall({ purpose: args.purpose, model: args.model, usage, ok: false, error: '빈 응답' });
    }
    throw new Error(`LLM(${args.model})이 빈 응답을 반환했습니다.`);
  }

  if (args.purpose) await recordCall({ purpose: args.purpose, model: args.model, usage });

  return { value: JSON.parse(content) as T, usage };
}

export async function structuredCall<T>(args: {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  effort?: ReasoningEffort;
  /** 어디서 부른 것인가. 주면 llm_call 에 기록한다(052) */
  purpose?: LlmPurpose;
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
  purpose?: LlmPurpose;
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
/**
 * 임베딩 모델이 한 번에 받는 최대 길이는 8,192 토큰이다. 그 이상은 400 으로 죽는다.
 *
 * 실제로 겪었다 — 조항 2,994건을 임베딩하다 **한 건**(14,584자) 때문에 배치 전체가
 * 죽어 2,994건이 통째로 밀렸다. 평균은 280자다. 만분의 일짜리 예외가 전부를 막는다.
 *
 * 한국어는 글자당 토큰이 1을 넘는 경우가 많아 글자 수로 넉넉히 잡는다. 6,000자면
 * 최악의 경우에도 8,192 토큰 안쪽이고, 이 저장소에서 그보다 긴 것은 표가 통째로
 * 들어간 조항 하나뿐이었다.
 *
 * 자르는 것이 옳은가 — 자르지 않으면 그 조항은 의미 검색에서 아예 빠진다.
 * 앞부분만이라도 있는 편이 없는 것보다 낫다. 다만 조용히 자르지는 않는다.
 */
const MAX_EMBED_CHARS = 6000;

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  // 차원을 환경변수로 바꾸려 한 배포를 시작하는 자리에서 잡는다(§4.5)
  assertEmbeddingDim();
  const cfg = openaiConfig();

  const input = texts.map((t) => {
    if (t.length <= MAX_EMBED_CHARS) return t;
    console.warn(
      `임베딩 입력이 길어 잘랐습니다: ${t.length}자 → ${MAX_EMBED_CHARS}자 ` +
      `(앞부분 "${t.slice(0, 40).replace(/\s+/g, ' ')}…")`,
    );
    return t.slice(0, MAX_EMBED_CHARS);
  });

  const res = await getOpenAI().embeddings.create({
    model: cfg.embeddingModel,
    input,
    dimensions: cfg.embeddingDim,
  });

  // 임베딩도 돈이 든다. 한 번에 여러 건을 보내므로 건수도 함께 남긴다(052).
  // 실제로 의미검색이 매번 기준 73종을 다시 임베딩하고 있었는데, 이런 낭비는
  // 기록이 없으면 드러나지 않는다
  await recordCall({
    purpose: 'embedding',
    model: cfg.embeddingModel,
    usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: 0, reasoningTokens: 0 },
    itemCount: input.length,
  });

  const vectors = res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);

  const dim = vectors[0]?.length ?? 0;
  if (dim !== cfg.embeddingDim) {
    throw new Error(
      `임베딩 차원이 맞지 않습니다: 모델 ${cfg.embeddingModel} 이 ${dim}차원을 반환했으나 ` +
        `스키마는 vector(${cfg.embeddingDim}) 입니다.\n` +
        '차원은 코드 상수로 고정돼 있습니다. 모델을 바꾸려면 DB 컬럼 타입·검색 함수 인자·' +
        '전량 재생성을 담은 마이그레이션을 함께 만들어야 합니다(§2.2).',
    );
  }
  return vectors;
}
