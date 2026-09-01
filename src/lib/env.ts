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

/**
 * CLI 에서 실행할 때 .env.local 을 읽는다.
 *
 * Next.js 는 .env.local 을 스스로 읽으므로 여기서 할 일이 없다.
 * 그런데 번들 안에서는 import.meta.dirname 이 undefined 라 경로 조합이 터진다.
 * 그 예외가 "DATABASE_URL 이 없다"는 진짜 원인을 가려 버리므로, 로딩 실패는
 * 조용히 넘기고 값 검증에서 걸리게 둔다.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const dir = import.meta.dirname;
  if (!dir) return; // 번들 환경 — 호스트가 이미 환경변수를 넣어 준다

  try {
    config({ path: join(dir, '..', '..', '.env.local'), quiet: true });
  } catch {
    // 파일이 없어도 진행한다. 필요한 값이 비면 required() 가 정확한 이름을 알려 준다
  }
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
    /**
     * 1차 태깅 반복 호출 횟수 (§4.3, 결정항목 14).
     *
     * 3회인 이유가 비용 계산에서 나온다. 실측 프롬프트 2,500토큰 기준
     * Luna 3회 = $0.00222, Terra 1회 = $0.00740. 싼 모델을 세 번 부르는 쪽이
     * 비싼 모델을 한 번 부르는 것보다 3.3배 싸다. 그래서 §5.2.3 이 "검수 정렬의
     * 주 지표"라 한 반복 일치도를 포기하지 않고도 예산 안에 들어온다.
     */
    bulkRepeat: optionalNumber('TAGGING_BULK_REPEAT', 3),
    /**
     * 이 값 미만이면 상위 모델로 승격한다.
     *
     * 1.0 = 만장일치가 아니면 승격. 3회 호출의 일치도는 1.0(3/3)·0.67(2/3)·
     * 0.33(제각각) 세 값만 나오므로, 1.0 은 "한 번이라도 이견이 있으면 다시 본다"는 뜻이다.
     * 행정 근거로 쓰는 자료라 이 정도가 안전하고, 비용도 감당된다.
     */
    escalateBelowAgreement: optionalNumber('TAGGING_ESCALATE_BELOW_AGREEMENT', 1.0),
    /** 검색용 텍스트 조립 규칙 변형(결정항목 9) */
    searchTextVariant: optional('SEARCH_TEXT_VARIANT', 'A'),
    /** RRF 완충값. 관행적으로 60 (§5.4) */
    rrfK: optionalNumber('RRF_K', 60),
    /** 코드 일치 가산 폭(결정항목 10) */
    weightCode: optionalNumber('RRF_WEIGHT_CODE', 0.5),
    weightCodePartial: optionalNumber('RRF_WEIGHT_CODE_PARTIAL', 0.2),
  };
}

/**
 * 모델 배치 — 2단 구조 (실측 근거는 docs/구현이력.md 라운드 5)
 *
 *   1차(bulk)      전량 태깅. 싼 모델을 여러 번 불러 반복 일치도를 얻는다.
 *   2차(escalate)  1차에서 답이 흔들린 건만. 상위 모델 1회.
 *   리랭킹         분석 1회에 후보 20건 — 건수가 적고 담당자가 기다리므로 품질 우선.
 *
 * GPT-5.6 계열 주의점 (실측 확인)
 *   - temperature 를 지원하지 않는다(기본 1 고정). 반복 호출로 답을 흔드는 데
 *     temperature 를 쓸 수 없고, 대신 이미 비결정적이라 반복만 하면 된다.
 *   - reasoning_effort 를 지원한다(none/low/medium/…). reasoning 토큰은 출력
 *     토큰으로 과금되므로 1차는 low, 승격은 medium 으로 둔다.
 */
export function openaiConfig() {
  return {
    apiKey: required('OPENAI_API_KEY'),

    bulkModel: optional('OPENAI_BULK_MODEL', 'gpt-5.6-luna'),
    bulkEffort: optional('OPENAI_BULK_EFFORT', 'low'),

    escalateModel: optional('OPENAI_ESCALATE_MODEL', 'gpt-5.6-terra'),
    escalateEffort: optional('OPENAI_ESCALATE_EFFORT', 'medium'),

    rerankModel: optional('OPENAI_RERANK_MODEL', 'gpt-5.6-terra'),
    rerankEffort: optional('OPENAI_RERANK_EFFORT', 'low'),

    /**
     * text-embedding-3-large 를 1536차원으로 자른다(Matryoshka).
     *
     * 실측: "유아용 의자는 측방·후방으로 전도되지 않아야 한다"(기준 문체)와
     * "아이가 앉은 의자가 옆으로 넘어져 떨어졌다"(사고 문체)의 유사도에서
     * 무관 문장과의 격차가 3-small 은 0.10, 3-large@1536 은 0.29 였다.
     * 설계문서 §5.2.1 이 지목한 "기준은 전도, 사고는 넘어짐" 간극을 훨씬 잘 잡는다.
     * 차원이 같으므로 vector(1536) 스키마를 바꾸지 않는다.
     */
    embeddingModel: optional('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-large'),
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
