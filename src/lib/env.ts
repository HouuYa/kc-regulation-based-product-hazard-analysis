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

/**
 * 숫자 환경변수. 범위를 벗어나면 조용히 기본값으로 바꾸지 않고 멈춘다.
 *
 * 왜 조용히 넘기지 않는가 (02_1차 보완 및 구현 설계서 §4.5)
 *   전에는 숫자로 읽히기만 하면 무엇이든 통과시켰다. TAGGING_CONCURRENCY=1000 은
 *   OpenAI 요청 한도에 걸려 실패만 잔뜩 만들고, RRF_K=-60 은 1/(k+등수) 의 분모를
 *   0 이나 음수로 만들어 점수 순서를 뒤집는다. 둘 다 오류로 죽지 않고 "결과가
 *   좀 이상한" 상태가 되므로 원인을 찾기가 가장 어려운 종류의 고장이다.
 *
 *   기본값으로 되돌리는 방식도 쓰지 않는다. 담당자는 값을 넣었다고 믿는데 실제로는
 *   다른 값으로 돌게 되어, 실측 결과를 잘못된 설정과 짝지어 기록하게 된다.
 *   설정 오류는 시작하는 자리에서 드러나는 편이 낫다.
 */
export function optionalNumber(
  name: string,
  fallback: number,
  range?: { min?: number; max?: number; integer?: boolean },
): number {
  const raw = optional(name, String(fallback));
  const n = Number(raw);

  if (!Number.isFinite(n)) {
    throw new Error(`환경변수 ${name} 가 숫자가 아닙니다: ${JSON.stringify(raw)}`);
  }
  if (range?.integer && !Number.isInteger(n)) {
    throw new Error(`환경변수 ${name} 는 정수여야 합니다: ${raw}`);
  }
  if (range?.min != null && n < range.min) {
    throw new Error(`환경변수 ${name} 는 ${range.min} 이상이어야 합니다: ${raw}`);
  }
  if (range?.max != null && n > range.max) {
    throw new Error(`환경변수 ${name} 는 ${range.max} 이하여야 합니다: ${raw}`);
  }
  return n;
}

/**
 * 주소줄로 들어오는 개수·건너뛰기 값을 다듬는다.
 *
 * 환경변수와 달리 이쪽은 아무나 보낼 수 있으므로 멈추지 않고 범위 안으로 자른다.
 * 다만 잘랐다는 사실은 응답에 실어 준다 — limit=99999 를 보낸 쪽이 20건만 받고도
 * 전부 받았다고 믿으면 자료가 빠진 줄 모른다.
 */
export function boundedInt(
  raw: string | null,
  fallback: number,
  { min, max }: { min: number; max: number },
): { value: number; clamped: boolean } {
  if (raw == null || raw.trim() === '') return { value: fallback, clamped: false };
  const n = Number(raw);
  if (!Number.isInteger(n)) return { value: fallback, clamped: true };
  if (n < min) return { value: min, clamped: true };
  if (n > max) return { value: max, clamped: true };
  return { value: n, clamped: false };
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
    bulkRepeat: optionalNumber('TAGGING_BULK_REPEAT', 3, { min: 1, max: 10, integer: true }),
    /**
     * 이 값 미만이면 상위 모델로 승격한다.
     *
     * 1.0 = 만장일치가 아니면 승격. 3회 호출의 일치도는 1.0(3/3)·0.67(2/3)·
     * 0.33(제각각) 세 값만 나오므로, 1.0 은 "한 번이라도 이견이 있으면 다시 본다"는 뜻이다.
     * 행정 근거로 쓰는 자료라 이 정도가 안전하고, 비용도 감당된다.
     */
    escalateBelowAgreement: optionalNumber('TAGGING_ESCALATE_BELOW_AGREEMENT', 1.0, { min: 0, max: 1 }),
    /**
     * 조항 코드 부여를 몇 건씩 동시에 할 것인가.
     *
     * 실측: 한 건에 약 17.8초(AI 3~4회 순차 호출). 순서대로만 하면 남은 5,896건에
     * 약 29시간이 걸려 "화면에서 눌러 두면 끝나는" 것이 불가능했다. 조항끼리는
     * 서로를 참조하지 않고 저장도 건별 트랜잭션이라 동시에 해도 안전하다.
     * 4면 약 7시간. 올릴수록 빨라지지만 OpenAI 요청 한도에 걸리면 실패가 늘어
     * 오히려 느려지므로, 한도를 아는 사람만 올리도록 기본값은 보수적으로 둔다.
     */
    taggingConcurrency: optionalNumber('TAGGING_CONCURRENCY', 4, { min: 1, max: 32, integer: true }),
    /** 검색용 텍스트 조립 규칙 변형(결정항목 9) */
    searchTextVariant: optional('SEARCH_TEXT_VARIANT', 'A'),
    /** RRF 완충값. 관행적으로 60 (§5.4) */
    rrfK: optionalNumber('RRF_K', 60, { min: 1, max: 1000, integer: true }),
    /** 코드 일치 가산 폭(결정항목 10) */
    weightCode: optionalNumber('RRF_WEIGHT_CODE', 0.5, { min: 0, max: 10 }),
    weightCodePartial: optionalNumber('RRF_WEIGHT_CODE_PARTIAL', 0.2, { min: 0, max: 10 }),
  };
}

/**
 * 모델 배치 — 2단 구조 (실측 근거는 구현이력.md 라운드 5)
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
     * 사고조사보고서 첨부 사진 분석(비전). 연간 50건 안팎이라 비용보다 품질이
     * 우선이지만, 가장 비싼 최상위 모델까지는 필요 없다는 것이 담당자 판단이라
     * escalate 와 같은 급(terra)을 기본값으로 둔다.
     */
    visionModel: optional('OPENAI_VISION_MODEL', 'gpt-5.6-terra'),
    visionEffort: optional('OPENAI_VISION_EFFORT', 'medium'),

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
    embeddingDim: EMBEDDING_DIM,
  };
}

/**
 * 임베딩 차원은 환경변수로 바꿀 수 없다 (02_1차 보완 및 구현 설계서 §4.5)
 *
 * 전에는 OPENAI_EMBEDDING_DIM 으로 바꿀 수 있었다. 그런데 이 값은 코드에만 있는
 * 것이 아니다 — clause.embedding·case_event.embedding 컬럼이 vector(1536) 이고,
 * 007 의 검색 함수 인자도 vector(1536) 이며, 020 의 자동 임베딩 SQL 도 그렇다.
 * 환경변수만 바꾸면 CLI 와 자동 작업과 DB 타입이 서로 다른 차원을 믿게 되고,
 * 그 어긋남은 "적재는 됐는데 검색이 이상하다"는 형태로 늦게 드러난다.
 *
 * 차원을 정말 바꿔야 하면 새 컬럼·새 색인·전체 재생성을 담은 마이그레이션으로만
 * 한다. 환경변수 한 줄로 할 수 있는 일이 아니다.
 *
 * 값을 넣어 둔 배포가 있을 수 있으므로, 다른 값이 설정돼 있으면 조용히 무시하지
 * 않고 시작하는 자리에서 알린다.
 */
export const EMBEDDING_DIM = 1536;

export function assertEmbeddingDim(): void {
  loadEnv();
  const raw = process.env.OPENAI_EMBEDDING_DIM?.trim();
  if (raw && Number(raw) !== EMBEDDING_DIM) {
    throw new Error(
      `OPENAI_EMBEDDING_DIM=${raw} 은 쓸 수 없습니다. 임베딩 차원은 ${EMBEDDING_DIM} 으로 고정돼 있습니다.\n` +
        '  DB 컬럼(vector(1536))과 검색 함수 인자가 같은 값을 전제하므로, 차원 변경은\n' +
        '  새 컬럼·새 색인·전체 재생성을 담은 마이그레이션으로만 할 수 있습니다.\n' +
        '  .env.local 에서 이 항목을 지우거나 1536 으로 두세요.',
    );
  }
}

export function recallConfig() {
  loadEnv();
  return {
    domestic: {
      baseUrl: process.env.DOMESTIC_RECALL_API_BASE_URL?.trim() ?? '',
      apiKey: process.env.DOMESTIC_RECALL_API_KEY?.trim() ?? '',
    },
  };
}

/**
 * GPC(GS1 국제 품목분류) 조회 — 우리 것이 아니라 협회의 별도 Supabase
 * 프로젝트(fczencruxulddednkint)에 이미 있는 벡터 색인(oecd_gpc_202405 표,
 * match_documents_202405 RPC)을 PostgREST로 직접 부른다(PDR 부록 F가 "1단계
 * HF/DT 완료 후 검토"라 미뤄 둔 항목, 2026-09-02 착수). anon 키로 이미 실행이
 * 되는 것을 확인했다 — 우리 쪽엔 GPC Brick 참조표·임베딩이 없고 만들 필요도
 * 없다(src/lib/gpc/lookup.ts 상단 주석 참고).
 */
export function gpcConfig() {
  loadEnv();
  return {
    dbUrl: optional('GPC_LOOKUP_URL', 'https://fczencruxulddednkint.supabase.co'),
    anonKey: required('GPC_LOOKUP_ANON_KEY'),
  };
}
