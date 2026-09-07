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
 */

import { structuredVisionCall } from './client';
import { openaiConfig } from '../env';
import type { ExtractedPhoto } from '../cases/extract-pdf';

export interface PhotoAnalysis {
  pageNumber: number;
  /** 실제 사고/제품 증거 사진인가(true), 로고·직인·서식 같은 장식 이미지인가(false) */
  isRelevantPhoto: boolean;
  /** 사진에 무엇이 보이는지 — 추정 없이 관찰만 */
  description: string;
  /** 위해요인과 관련될 만한 관찰(손상·탄 흔적·파손 등). 없으면 빈 문자열 */
  hazardNote: string;
}

export interface VisionResult {
  photos: PhotoAnalysis[];
  /** 증거 사진들을 종합한 제품 서술 한 문장. GPC 조회 입력으로 쓴다. 없으면 빈 문자열 */
  productDescription: string;
  model: string;
}

const SYSTEM = `당신은 제품안전 사고조사보고서에 첨부된 사진을 분석하는 보조원이다.

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

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['photos', 'product_description'],
  properties: {
    photos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['page_number', 'is_relevant_photo', 'description', 'hazard_note'],
        properties: {
          page_number: { type: 'integer' },
          is_relevant_photo: { type: 'boolean' },
          description: { type: 'string' },
          hazard_note: { type: 'string' },
        },
      },
    },
    product_description: { type: 'string' },
  },
} as const;

interface RawOutput {
  photos: Array<{
    page_number: number;
    is_relevant_photo: boolean;
    description: string;
    hazard_note: string;
  }>;
  product_description: string;
}

export async function analyzePhotos(
  photos: ExtractedPhoto[],
  context: { itemName: string | null; title: string | null },
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
    system: SYSTEM,
    user,
    images: photos.map((p) => ({
      dataUrl: `data:image/jpeg;base64,${p.jpeg.toString('base64')}`,
    })),
    schemaName: 'photo_analysis', purpose: 'tagging',
    schema: SCHEMA,
    effort: cfg.visionEffort as never,
  });

  return {
    photos: value.photos.map((p) => ({
      pageNumber: p.page_number,
      isRelevantPhoto: p.is_relevant_photo,
      description: p.description,
      hazardNote: p.hazard_note,
    })),
    productDescription: value.product_description,
    model: cfg.visionModel,
  };
}
