/**
 * 사고조사보고서 첨부 사진 분석 (비전)
 *
 * 실측 근거(2026-09-02): 사고 5건 중 다수가 "시험 결과 안전기준 적합"이라는
 * 텍스트만 남아 원인 미확인(HF.UNKNOWN)으로 끝났다(구현이력 라운드 4/5).
 * 텍스트에는 없는 손상·결함 단서가 사진에 있을 수 있어 붙인다.
 *
 * HF/DT 코드화(tagging.ts)와는 분리한다. 사진 분석은 "무엇이 보이는가"를
 * 서술하는 관찰 단계이고, 코드를 직접 고르지 않는다 — 근거 없는 추정을
 * 막는 원칙(§5.2.2)을 사진에도 그대로 적용한다. 대신 사진에서 뽑은 제품
 * 서술문을 GPC 조회(src/lib/gpc/lookup.ts)의 입력으로 재사용한다.
 *
 * variant A/B (라운드 71~72, VISION_PROMPT_VARIANT)
 *   라운드 69가 진단한 것 — 사진의 다수(사건 50건 표본)가 손상 사진이 아니라
 *   온도그래프(40~90℃ 반복)·전력분석기 화면(220.86V·8.660A·1.9125kW)·내부
 *   기판(전지·펌프·밸브·히터 커넥터) 같은 시험 측정 자료다. 원인을 단정할
 *   근거는 아니지만 시험항목을 고르는 데는 바로 쓸 재료인데, "손상·탄 흔적·
 *   파손·변형"으로 좁힌 프롬프트(A)가 그 재료를 버리고 있었다.
 *
 *   B 는 A 위에 measurements(측정값)·components(부품 구성) 두 필드만 더한다.
 *   hazard_note 정의는 손대지 않는다 — 그 필드의 좁은 정의 자체는 "손상 관찰"
 *   이라는 원래 목적에 맞고, 라운드 68~69 가 이미 "사진 단서를 원인 코드화
 *   (tag-cases.ts)에 얹는 것은 효과가 없었다"(대조군을 빼도 같은 코드가
 *   나왔다)고 확인해 둔 경로다. 새 재료는 그 경로로 보내지 않고 병행 점검
 *   (second-opinion)의 시험 범위 판단에만 쓴다 — 라운드 69가 실효성을 입증한
 *   경로가 아니므로, 여기서도 반드시 대조군(사진 재료 있음/없음)으로 재본다.
 */

import { structuredVisionCall } from './client';
import { openaiConfig } from '../env';
import type { ExtractedPhoto } from '../cases/extract-pdf';

export type VisionPromptVariant = 'A' | 'B';

export interface PhotoMeasurement {
  label: string;
  value: string;
  unit: string;
}

export interface PhotoAnalysis {
  pageNumber: number;
  /** 실제 사고/제품 증거 사진인가(true), 로고·직인·서식 같은 장식 이미지인가(false) */
  isRelevantPhoto: boolean;
  /** 사진에 무엇이 보이는지 — 추정 없이 관찰만 */
  description: string;
  /** 위해요인과 관련될 만한 관찰(손상·탄 흔적·파손 등). 없으면 빈 문자열 */
  hazardNote: string;
  /** variant B 에서만 채워진다. 온도그래프·전력계 화면 등 사진에 표시된 측정값 */
  measurements: PhotoMeasurement[];
  /** variant B 에서만 채워진다. 내부 기판·부품 사진에서 식별한 부품 구성 */
  components: string[];
}

export interface VisionResult {
  photos: PhotoAnalysis[];
  /** 증거 사진들을 종합한 제품 서술 한 문장. GPC 조회 입력으로 쓴다. 없으면 빈 문자열 */
  productDescription: string;
  model: string;
  variant: VisionPromptVariant;
}

const SYSTEM_BASE = `당신은 제품안전 사고조사보고서에 첨부된 사진을 분석하는 보조원이다.

규칙
- 각 사진마다 먼저 실제 사고·제품 증거 사진인지(is_relevant_photo=true), 아니면
  기관 로고·직인·서식 같은 장식 이미지인지(false) 판단한다.
- description 은 사진에 실제로 보이는 것만 적는다. 안 보이는 것을 추정하지 않는다.
- hazard_note 는 손상 부위, 탄 흔적, 파손, 변형처럼 위해요인 판단에 참고될 만한
  관찰이 있을 때만 적는다. 없으면 빈 문자열로 둔다 — 근거 없이 원인을 짐작하지 않는다.
- product_description 은 증거 사진(is_relevant_photo=true)들을 종합해 "무엇에 관한
  제품인가"를 한 문장으로 적는다. 이 문장은 다른 시스템이 제품분류 코드를 찾는 데
  그대로 쓰인다 — 재질·형태·용도 같은 분류에 도움되는 관찰 위주로 쓴다.
  증거 사진이 하나도 없으면 빈 문자열로 둔다.`;

const SYSTEM_MEASUREMENTS = `

- measurements 는 사진에 숫자로 표시된 측정값만 적는다. 온도그래프의 눈금·전력
  분석기 화면의 전압/전류/전력 표시·계기판 수치 등이 해당한다. 사진에 실제로
  보이는 숫자만 옮겨 적는다 — 그래프를 보고 값을 추정하거나 계산하지 않는다.
  숫자가 없으면 빈 배열로 둔다.
- components 는 내부 기판·부품 사진에서 실제로 식별할 수 있는 부품 이름만
  적는다("PCB", "전지", "펌프", "밸브", "히터 커넥터" 등). 무엇인지 확신할 수
  없으면 적지 않는다. 없으면 빈 배열로 둔다.`;

function systemPrompt(variant: VisionPromptVariant): string {
  return variant === 'B' ? SYSTEM_BASE + SYSTEM_MEASUREMENTS : SYSTEM_BASE;
}

/**
 * 쪽 번호를 실제 첨부 쪽의 enum 으로 고정한다 (2026-09-08)
 *
 * 전에는 정수면 무엇이든 받았다. 모델이 쪽을 하나 건너뛰거나 없는 쪽을 적으면
 * 사진 설명이 엉뚱한 쪽에 붙는데, 그 결과는 화면에 그대로 나가고 사람이 사진과
 * 대조하지 않는 한 드러나지 않는다.
 *
 * 정수 enum 은 OpenAI 가 거절하므로(rerank.ts 주석 참고) 문자열로 받아 코드에서
 * 숫자로 되돌린다.
 */
function buildSchema(pageNumbers: number[], variant: VisionPromptVariant) {
  const measurementFields = {
    measurements: {
      type: 'array',
      description: '사진에 숫자로 표시된 측정값(온도그래프·전력계 화면 등). 없으면 빈 배열',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value', 'unit'],
        properties: {
          label: { type: 'string', description: '무엇을 잰 값인가' },
          value: { type: 'string', description: '사진에 보이는 숫자 그대로. 범위면 "40~90"처럼' },
          unit: { type: 'string', enum: ['℃', 'V', 'A', 'W', 'kW', 'mA', 'MΩ', '%', '기타'] },
        },
      },
    },
    components: {
      type: 'array',
      items: { type: 'string' },
      description: '내부 기판·부품 사진에서 식별한 부품 이름. 확신 없으면 적지 않는다',
    },
  } as const;

  return {
    type: 'object',
    additionalProperties: false,
    required: ['photos', 'product_description'],
    properties: {
      photos: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'page_number', 'is_relevant_photo', 'description', 'hazard_note',
            ...(variant === 'B' ? ['measurements', 'components'] : []),
          ],
          properties: {
            page_number: {
              type: 'string',
              enum: [...new Set(pageNumbers)].map(String),
              description: '이 사진이 있던 보고서 쪽 번호. 준 순서와 같아야 한다',
            },
            is_relevant_photo: { type: 'boolean', description: '실제 사고·제품 증거 사진인가' },
            description: { type: 'string', description: '사진에 실제로 보이는 것만' },
            hazard_note: { type: 'string', description: '손상·탄 흔적·파손 등 관찰. 없으면 빈 문자열' },
            ...(variant === 'B' ? measurementFields : {}),
          },
        },
      },
      product_description: { type: 'string', description: '증거 사진들을 종합한 제품 서술 한 문장' },
    },
  } as const;
}

interface RawOutput {
  photos: Array<{
    page_number: string;
    is_relevant_photo: boolean;
    description: string;
    hazard_note: string;
    measurements?: PhotoMeasurement[];
    components?: string[];
  }>;
  product_description: string;
}

export async function analyzePhotos(
  photos: ExtractedPhoto[],
  context: { itemName: string | null; title: string | null },
  variant: VisionPromptVariant = 'A',
): Promise<VisionResult> {
  const cfg = openaiConfig();
  const user = [
    context.itemName ? `품목(추정): ${context.itemName}` : '',
    context.title ? `보고서 제목: ${context.title}` : '',
    `첨부된 사진 ${photos.length}장을 분석한다. 사진은 보고서에 등장한 순서(페이지 번호)대로 준다.`,
    '각 사진의 page_number 는 아래 순서와 정확히 맞춰서 답한다: ' +
      photos.map((p) => p.pageNumber).join(', '),
  ]
    .filter(Boolean)
    .join('\n');

  const { value } = await structuredVisionCall<RawOutput>({
    model: cfg.visionModel,
    system: systemPrompt(variant),
    user,
    images: photos.map((p) => ({
      dataUrl: `data:image/jpeg;base64,${p.jpeg.toString('base64')}`,
    })),
    // 태깅과 한 줄로 합쳐 기록하던 것을 갈랐다 (2026-09-08)
    //   둘 다 같은 급의 모델을 쓰므로 모델명으로도 갈라낼 수 없어, 사진 분석에
    //   얼마를 쓰는지 셀 수 없었다. 사진은 호출 한 번이 비싸므로 따로 보여야 한다
    schemaName: variant === 'B' ? 'photo_analysis_v2' : 'photo_analysis', purpose: 'vision',
    schema: buildSchema(photos.map((p) => p.pageNumber), variant),
    effort: cfg.visionEffort as never,
  });

  return {
    photos: value.photos.map((p) => ({
      pageNumber: Number(p.page_number),
      isRelevantPhoto: p.is_relevant_photo,
      description: p.description,
      hazardNote: p.hazard_note,
      measurements: p.measurements ?? [],
      components: p.components ?? [],
    })),
    productDescription: value.product_description,
    model: cfg.visionModel,
    variant,
  };
}
