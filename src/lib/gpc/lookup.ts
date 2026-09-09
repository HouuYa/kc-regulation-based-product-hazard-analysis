/**
 * GPC(GS1 국제 품목분류) 조회 — 협회의 별도 Supabase(fczencruxulddednkint)에
 * 이미 있는 벡터 색인을 pgvector RPC로 직접 조회한다.
 *
 * 처음엔 그 프로젝트의 edge function(`/find-gpc`)을 그대로 부르려 했는데
 * 실측(2026-09-02)으로 두 가지 문제를 발견해 방식을 바꿨다.
 *
 *   1) edge function은 match_count를 1로 고정해서 top-1만 준다. 담당자가
 *      원한 "후보 3~5개"를 낼 수 없다.
 *   2) edge function 안의 OpenAI 키가 크레딧 소진 상태라 항상 429로 실패한다.
 *
 * 그런데 그 edge function이 부르는 RPC 함수(`match_gpc_vector`)와, n8n
 * 워크플로("(GS1) [한국리콜__OECD] OECD GPC RAG.json")가 직접 참조하는
 * 벡터 표(`oecd_gpc_202405`)·RPC(`match_documents_202405`)가 **같은 프로젝트
 * 안에 있고, anon 키로 이미 직접 호출이 된다**(PostgREST RPC 엔드포인트로
 * 실측 확인 — 401/403이 아니라 정상 실행됨). 그래서 그 프로젝트의 edge
 * function을 거치지 않고, 우리 OpenAI 키로 직접 임베딩을 만들어 이 RPC를
 * 바로 부른다 — 후보 개수도 우리가 정하고, 크레딧 문제와도 무관해진다.
 *
 * 임베딩 모델은 반드시 text-embedding-3-small 이어야 한다(그 표를 채울 때 쓴
 * 모델과 같아야 벡터 공간이 맞는다 — 우리 프로젝트의 조항 임베딩은
 * text-embedding-3-large@1536 을 쓰지만 이건 남의 색인이라 그쪽 모델을
 * 그대로 따른다).
 *
 * 절대 유사도 값 자체는 낮다(실측: 정답 브릭도 0.25 안팎). 임계값으로
 * 거르지 않고 순위(top-N)로만 판단한다 — 실측에서 1위는 정확했고 2~5위는
 * 확연히 무관했다.
 */

import OpenAI from 'openai';
import { gpcConfig, required } from '../env';

const EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * 후보를 몇 개까지 받을 것인가의 공통 기본값(standard·case_event 공유).
 *
 * 처음엔 5개였다. 라운드 10(KC기준) 실측에서 좁게 뽑으면 정답이 후보 밖으로
 * 밀려나는 사례가 나왔다(절대 유사도 자체가 낮은 인덱스라 순위가 잘 흔들린다) —
 * top-20까지 넓혀서야 정답이 잡히는 경우가 있었다. 그래서 15로 늘렸고,
 * 라운드 11에서 사고사진 GPC(case_event)에도 같은 기본값을 맞췄다
 * (findAndVerifyGpc()가 LLM 검증을 한 번만 거치므로 후보를 늘려도 LLM
 * 비용은 늘지 않는다 — 늘어나는 건 임베딩 RPC 호출뿐이다).
 */
export const DEFAULT_GPC_CANDIDATE_COUNT = 15;

export interface GpcCandidate {
  rank: number;
  brickCode: string;
  brickTitle: string;
  classCode: string;
  classTitle: string;
  familyCode: string;
  familyTitle: string;
  segmentCode: string;
  segmentTitle: string;
  similarity: number;
}

interface RawRow {
  id: number;
  content: string;
  similarity: number;
}

interface RawContent {
  brick_code: string;
  brick_title: string;
  class_code: string;
  class_title: string;
  family_code: string;
  family_title: string;
  segment_code: string;
  segment_title: string;
}

let embeddingClient: OpenAI | null = null;
function getEmbeddingClient(): OpenAI {
  if (embeddingClient) return embeddingClient;
  embeddingClient = new OpenAI({ apiKey: required('OPENAI_API_KEY') });
  return embeddingClient;
}

async function embedForGpc(text: string): Promise<number[]> {
  const res = await getEmbeddingClient().embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return res.data[0].embedding;
}

/**
 * 상품명·설명으로 GPC 브릭 후보를 유사도 순으로 가져온다.
 *
 * @param matchCount 몇 개까지 받을 것인가 — 사고보고서 품목 후보용은 3~5 권장
 */
export async function findGpcCandidates(
  productName: string,
  productDescription?: string,
  matchCount = 5,
): Promise<GpcCandidate[]> {
  return (await findGpcCandidatesWithQuery(productName, productDescription, matchCount)).candidates;
}

/**
 * 후보와 함께 **무엇으로 찾았는지**(질의문)도 돌려준다.
 *
 * 협회 n8n 워크플로(「(GS1) [한국리콜__OECD] OECD GPC RAG」)는 판정 결과에
 * `search_strategy_description` 이라는 칸을 두고 "무엇으로 검색해서 어떤 후보가
 * 나왔고 왜 그것을 골랐는지"를 말로 적게 한다. 우리는 「왜 골랐는지」(reasoning)만
 * 남기고 있었다 — 검수하는 사람이 "그럼 뭘로 찾은 건데"를 되짚을 수 없었다.
 *
 * 말로 적게 하는 대신 실제 질의문과 실제 후보 목록을 자료로 남긴다. 모델이 적은
 * 설명은 틀릴 수 있지만 우리가 보낸 질의문은 사실이기 때문이다.
 */
export async function findGpcCandidatesWithQuery(
  productName: string,
  productDescription?: string,
  matchCount = 5,
): Promise<{ candidates: GpcCandidate[]; queryText: string }> {
  const cfg = gpcConfig();
  const inputText = `${productName}: ${productDescription ?? ''}`.trim();
  if (!inputText) return { candidates: [], queryText: '' };

  const embedding = await embedForGpc(inputText);

  const res = await fetch(`${cfg.dbUrl}/rest/v1/rpc/match_documents_202405`, {
    method: 'POST',
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query_embedding: embedding, match_count: matchCount }),
  });

  const rows = (await res.json()) as RawRow[] | { message: string };
  if (!res.ok || !Array.isArray(rows)) {
    throw new Error(`GPC 후보 조회 실패: ${JSON.stringify(rows)}`);
  }

  const candidates = rows.map((r, i) => {
    const c = JSON.parse(r.content) as RawContent;
    return {
      rank: i + 1,
      brickCode: c.brick_code,
      brickTitle: c.brick_title,
      classCode: c.class_code,
      classTitle: c.class_title,
      familyCode: c.family_code,
      familyTitle: c.family_title,
      segmentCode: c.segment_code,
      segmentTitle: c.segment_title,
      similarity: r.similarity,
    };
  });

  return { candidates, queryText: inputText };
}

/** 가장 가까운 브릭 하나만 필요할 때 */
export async function findGpcTop1(
  productName: string,
  productDescription?: string,
): Promise<GpcCandidate | null> {
  const [top] = await findGpcCandidates(productName, productDescription, 1);
  return top ?? null;
}
