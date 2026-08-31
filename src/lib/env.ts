/**
 * 환경변수 로딩과 검증
 *
 * 자격증명은 .env.local 에만 둔다. 저장소에는 .env.example 만 올라간다(.gitignore).
 *
 * 필요한 값이 없을 때 조용히 undefined 로 진행하지 않고 그 자리에서 멈춘다.
 * 배치가 절반쯤 돌다가 인증 오류로 죽으면 어디까지 처리됐는지 되짚기 어렵기 때문이다.
 */

import { config } from 'dotenv';
import { join } from 'node:path';

let loaded = false;

/** CLI 에서 실행할 때 .env.local 을 읽는다. Next.js 는 스스로 읽으므로 무해하다. */
export function loadEnv(): void {
  if (loaded) return;
  const root = join(import.meta.dirname, '..', '..');
  config({ path: join(root, '.env.local'), quiet: true });
  loaded = true;
}

export function required(name: string): string {
  loadEnv();
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `환경변수 ${name} 가 비어 있습니다. .env.local 에 값을 넣어 주세요.\n` +
        `  (.env.example 에 항목 목록이 있습니다)`,
    );
  }
  return v.trim();
}

export function optional(name: string, fallback: string): string {
  loadEnv();
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export function optionalNumber(name: string, fallback: number): number {
  const v = optional(name, String(fallback));
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 태깅·검색 파라미터 (설계문서 결정항목 9·10·14 — 하드코딩하지 않는다) */
export function tuning() {
  return {
    /** 반복 일치도 산정용 호출 횟수. 0단계는 3회로 시작(결정항목 14) */
    repeatCount: optionalNumber('TAGGING_REPEAT_COUNT', 3),
    /** 검색용 텍스트 조립 규칙 변형(결정항목 9) */
    searchTextVariant: optional('SEARCH_TEXT_VARIANT', 'A'),
    /** RRF 완충값. 관행적으로 60 (§5.4) */
    rrfK: optionalNumber('RRF_K', 60),
    /** 코드 일치 가산 폭(결정항목 10) */
    weightCode: optionalNumber('RRF_WEIGHT_CODE', 0.5),
    weightCodePartial: optionalNumber('RRF_WEIGHT_CODE_PARTIAL', 0.2),
  };
}

export function openaiConfig() {
  return {
    apiKey: required('OPENAI_API_KEY'),
    taggingModel: optional('OPENAI_TAGGING_MODEL', 'gpt-4.1-mini'),
    rerankModel: optional('OPENAI_RERANK_MODEL', 'gpt-4.1-mini'),
    embeddingModel: optional('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
    /** 설계문서의 vector(1536) 과 맞춘다. 바꾸면 스키마도 함께 바꿔야 한다 */
    embeddingDim: optionalNumber('OPENAI_EMBEDDING_DIM', 1536),
  };
}

export function recallConfig() {
  loadEnv();
  return {
    hub: {
      baseUrl: optional('RECALL_HUB_API_BASE_URL', 'https://recall-hub-admin-dev.vercel.app'),
      apiKey: process.env.RECALL_HUB_API_KEY?.trim() ?? '',
    },
    domestic: {
      baseUrl: process.env.DOMESTIC_RECALL_API_BASE_URL?.trim() ?? '',
      apiKey: process.env.DOMESTIC_RECALL_API_KEY?.trim() ?? '',
    },
  };
}
