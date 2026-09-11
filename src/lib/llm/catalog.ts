import { openaiConfig } from '../env';
import type { LlmPurpose } from './client';

/**
 * AI 를 부르는 자리 목록 — 화면과 문서가 같은 것을 보게 하는 한 곳 (2026-09-08)
 *
 * 전에는 이 표가 docs/AI_사용_관리.md 에만 손으로 적혀 있었다. 손으로 적은 표는
 * 코드가 바뀌면 조용히 틀린다 — 실제로 사진 분석이 태깅으로 기록되고 있었는데
 * 문서에는 열 번째 자리로 따로 적혀 있었다.
 *
 * 그래서 부르는 자리를 코드에 정의하고, 화면(/llm)과 문서가 이것을 읽는다.
 * 모델명은 환경변수에서 **실행 시점에** 읽으므로, 배포에 실제로 설정된 값이 보인다.
 *
 * 여기 적는 네 가지가 이 체계의 안전장치다.
 *   goal      무엇을 묻나 — 담당자의 말로
 *   enumLock  고를 대상을 목록으로 못박았나. 이것이 "없는 값 창작"을 구조로 막는다
 *   evidence  판단 근거를 어느 필드로 받나 — 없으면 검수가 그저 믿는 일이 된다
 *   storedAt  그 근거가 DB 어디에 남나 — 남지 않으면 나중에 되짚을 수 없다
 */

export interface CallSite {
  purpose: LlmPurpose;
  /** 여섯 걸음 흐름(site/index.html) 기준의 묶음. 흐름 밖의 사전 준비 작업은 '사전 관리', 여러 걸음에 걸치면 '공통' */
  stage: '기준 적재' | '위해요인 코드 부여' | '품목 확정' | '분석 실행' | '사전 관리' | '공통';
  /** 담당자에게 보일 이름 */
  name: string;
  /** 언제 도나 */
  when: string;
  /** 무엇을 묻나 */
  goal: string;
  /** 어느 환경변수의 모델을 쓰나 */
  modelEnv: string;
  /** 구조화 출력 스키마 이름 (client.ts 의 schemaName) */
  schema: string;
  /** 고를 대상을 enum 으로 못박았는가. 못박지 못하는 자리는 그 이유를 적는다 */
  enumLock: string;
  /** 판단 근거를 받는 필드 */
  evidence: string;
  /** 그 근거가 DB 어디에 남는가 */
  storedAt: string;
  /** 어느 화면에서 결과를 보나. 없으면 '—' */
  screen: string;
}

export const CALL_SITES: CallSite[] = [
  {
    purpose: 'gpc_verify',
    stage: '기준 적재',
    name: 'GPC 계위 검증',
    when: '기준에 품목분류를 붙일 때',
    goal: '벡터 검색이 물어온 GPC 후보 중 맞는 계층을 고른다',
    modelEnv: 'OPENAI_RERANK_MODEL',
    schema: 'gpc_verification',
    enumLock: 'Brick·Class·Family·Segment 코드 + NONE 을 enum 으로 고정',
    evidence: 'reasoning (어느 계층까지 왜 내려갔는지)',
    storedAt: 'standard.gpc_verification (JSON)',
    screen: '안전기준',
  },
  {
    purpose: 'tagging',
    stage: '위해요인 코드 부여',
    name: '위해요인 코드 부여',
    when: '사고보고서·리콜을 사건으로 만들 때 · 조항을 적재할 때',
    goal: '서술에 맞는 HF(위해요인)·DT(사고유형) 코드를 고른다',
    modelEnv: 'OPENAI_BULK_MODEL → (흔들리면) OPENAI_ESCALATE_MODEL',
    schema: 'hazard_tagging',
    enumLock: '코드북의 코드 전체를 enum 으로 고정 — 없는 코드를 만들 수 없다',
    evidence: 'evidence_span (원문 인용, 필수)',
    storedAt: 'case_tag.evidence_span · clause_tag.evidence_span',
    screen: '사고보고서 · 리콜 · 안전기준',
  },
  {
    purpose: 'vision',
    stage: '위해요인 코드 부여',
    name: '사고 사진 분석',
    when: '사진이 붙은 사고보고서를 적재할 때',
    goal: '사진마다 무엇이 보이는지, 사고와 관련된 사진인지 가른다',
    modelEnv: 'OPENAI_VISION_MODEL',
    schema: 'photo_analysis',
    enumLock: '쪽 번호를 실제 첨부 쪽의 enum 으로 고정 — 없는 쪽을 가리킬 수 없다',
    evidence: 'description · hazard_note (보이는 것만 적게 한다)',
    storedAt: 'source_file.photo_analysis (JSON)',
    screen: '사고보고서',
  },
  {
    purpose: 'scope_semantic',
    stage: '품목 확정',
    name: '적용범위 의미검색',
    when: '품목 확정 — 사전에 없는 품목',
    goal: '적용범위 원문과 뜻으로 견주어 기준 하나를 고르거나 NONE',
    modelEnv: 'OPENAI_RERANK_MODEL',
    schema: 'scope_verification',
    enumLock: '후보 기준 id + NONE 을 enum 으로 고정',
    evidence: 'reasoning (적용범위의 어느 대목을 근거로 골랐는지)',
    storedAt: 'scope_term.evidence · case_event.scope_evidence',
    screen: '품목 용어 사전 · 사고보고서 · 리콜',
  },
  {
    purpose: 'scope_filter',
    stage: '품목 확정',
    name: '적용범위 후보 거르기',
    when: '품목 확정 — 원문검색이 둘 이상 물어 왔을 때',
    goal: '넓게 걸린 후보에서 실제로 적용되는 것만 남긴다',
    modelEnv: 'OPENAI_RERANK_MODEL',
    schema: 'scope_filter',
    enumLock: '후보 기준 id 를 enum 으로 고정 · 빈 배열 허용(전부 아님)',
    evidence: 'reasoning (왜 그렇게 갈랐는지)',
    storedAt: 'case_event.scope_evidence',
    screen: '사고보고서 · 리콜',
  },
  {
    purpose: 'rerank',
    stage: '분석 실행',
    name: '조항 재채점',
    when: '분석 실행 — 후보 조항의 순위를 다시 매길 때',
    goal: '사건과 조항이 실제로 맞는지 0~1 로 매기고 이유를 적는다',
    modelEnv: 'OPENAI_RERANK_MODEL',
    schema: 'rerank_scores',
    enumLock: '후보 조항 id 를 enum 으로 고정 — 후보 밖 조항이 나올 수 없다',
    evidence: 'reason (후보마다 한 줄)',
    storedAt: 'match_result.rerank_reason',
    screen: '분석 결과',
  },
  {
    purpose: 'hyde',
    stage: '분석 실행',
    name: '가상 조항 생성 (HyDE)',
    when: '분석 실행 — 의미 검색 질의를 다듬을 때',
    goal: '사고 서술로 「답에 해당할 법한 조항」을 지어내 질의로 쓴다',
    modelEnv: 'OPENAI_RERANK_MODEL',
    schema: 'hypothetical_clause',
    enumLock: '없음 — 지어내는 것이 목적이라 고정할 대상이 없다',
    evidence: '지어낸 문단 자체',
    storedAt: 'match_run.hyde_text',
    screen: '아직 보여 주지 않는다 (기준 원문으로 오해할 수 있어서)',
  },
  {
    purpose: 'scope_suggest',
    stage: '사전 관리',
    name: '품목 기준 제안',
    when: '용어 사전 채우기 (`npm run scope:suggest`)',
    goal: '품목명에 맞는 기준을 목록에서 고른다',
    modelEnv: 'OPENAI_RERANK_MODEL',
    schema: 'scope_suggestion',
    enumLock: '기준 id 를 enum 으로 고정 (2026-09-08 이전에는 이름을 자유 문자열로 받았다)',
    evidence: 'reason · confidence',
    storedAt: 'scope_term.evidence (source=LLM · 미검수)',
    screen: '품목 용어 사전',
  },
  {
    purpose: 'alias',
    stage: '사전 관리',
    name: '검색어(별칭) 생성',
    when: '검색어 사전 — 「AI로 검색어 더 만들기」',
    goal: '법정 품목을 사람들이 부르는 일상어를 만든다',
    modelEnv: 'OPENAI_RERANK_MODEL',
    schema: 'item_aliases',
    enumLock: '대상 품목명을 enum 으로 고정 (2026-09-08) · 검색어 자체는 만들어 내는 것이라 고정 불가',
    evidence: 'note',
    storedAt: 'item_keyword.evidence (source=LLM · 미검수)',
    screen: '품목 검색어 사전',
  },
  {
    purpose: 'taxonomy_link',
    stage: '사전 관리',
    name: '법정 품목 → 기준 잇기',
    when: '대응표를 만들 때 (`npm run taxonomy:link`)',
    goal: '법정 품목에 맞는 안전기준을 후보에서 고른다',
    modelEnv: 'OPENAI_RERANK_MODEL',
    schema: 'taxonomy_standard_links',
    enumLock: '후보 기준 id + NONE 을 enum 으로 고정',
    evidence: 'reasoning · confidence_score',
    storedAt: 'taxonomy_standard.evidence',
    screen: '품목 검색어 사전',
  },
  {
    purpose: 'embedding',
    stage: '공통',
    name: '임베딩',
    when: '조항·사건·적용범위를 뜻으로 견주려고',
    goal: '문장을 1536차원 벡터로 옮긴다',
    modelEnv: 'OPENAI_EMBEDDING_MODEL',
    schema: '— (구조화 출력이 아니다)',
    enumLock: '해당 없음',
    evidence: '해당 없음',
    storedAt: 'clause.embedding · case_event.embedding · standard.scope_embedding (모델명 함께 저장)',
    screen: '운영 (임베딩 현황)',
  },
];

/** 환경변수에 실제로 설정된 모델을 붙여 돌려준다 — 배포마다 다를 수 있다 */
export function callSitesWithModels(): Array<CallSite & { models: string[] }> {
  const c = openaiConfig();
  const resolve = (env: string): string[] => {
    const out: string[] = [];
    if (env.includes('OPENAI_BULK_MODEL')) out.push(c.bulkModel);
    if (env.includes('OPENAI_ESCALATE_MODEL')) out.push(c.escalateModel);
    if (env.includes('OPENAI_RERANK_MODEL')) out.push(c.rerankModel);
    if (env.includes('OPENAI_VISION_MODEL')) out.push(c.visionModel);
    if (env.includes('OPENAI_EMBEDDING_MODEL')) out.push(c.embeddingModel);
    return [...new Set(out)];
  };
  return CALL_SITES.map((s) => ({ ...s, models: resolve(s.modelEnv) }));
}
