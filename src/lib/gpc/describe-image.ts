/**
 * 제품 사진 판독 — 사진에서 「무엇인 제품인가」를 뽑아 품목분류의 입력으로 쓴다
 *
 * 어디서 왔나
 *   협회 n8n 워크플로 「이미지 처리 연습」(docs/OECD리콜등록/)의 이식본이다.
 *   그 워크플로는 리콜 건의 제품 사진을 Supabase 저장소에서 내려받아 비전 모델에
 *   먹이고, 「전기용품안전관리법이냐 어린이제품안전특별법이냐」를 가리는 데 필요한
 *   관찰을 한국어로 뽑아낸다. 뽑은 서술은 다음 단계(GPC 분류·법령 판정)의 재료다.
 *
 * 왜 여기(gpc/)에 두나
 *   해외 리콜 공고는 제품명이 「의자」·「나선형 장난감」처럼 짧고, 설명이 아예
 *   없는 경우도 많다. 그런 글자만으로는 벡터 색인이 엉뚱한 브릭을 물어 온다.
 *   사진에서 뽑은 서술을 질의문에 보태면 그 자리가 메워진다 — 이 모듈의 결과는
 *   findAndVerifyGpc() 의 productContext 로 그대로 들어간다.
 *
 * 지금은 부르는 곳이 없다 (2026-09-09)
 *   담당자 요청이 "사진을 읽어 들이는 로직은 추후 사용 가능하므로 구현만"이었다.
 *   리콜 사진은 협회 저장소에 있고 우리 쪽 수집 경로가 아직 정해지지 않았다.
 *   경로가 정해지면 사진을 받아 describeProductImages() 를 부르고, 그 결과를
 *   assignGpcFromImages() 처럼 이어 붙이면 된다.
 *
 * 사고보고서 첨부사진(src/lib/llm/vision.ts)과 무엇이 다른가
 *   그쪽은 여러 장이 섞인 보고서에서 「이건 증거 사진인가 기관 로고인가」부터
 *   가리고, 손상·탄 흔적 같은 위해 단서를 함께 뽑는다. 여기는 제품 사진임이
 *   이미 분명한 상태에서 「이 제품이 무엇인가」만 본다. 목적이 달라 프롬프트도
 *   스키마도 다르므로 합치지 않았다.
 */

import { structuredVisionCall } from '../llm/client';
import { openaiConfig } from '../env';
import { findAndVerifyGpc, DEFAULT_GPC_CANDIDATE_COUNT, type GpcAssignment } from './assign';

export interface ProductImage {
  /** data:image/jpeg;base64,... 형태의 이미지 */
  dataUrl: string;
  /** 어느 파일에서 왔는지. 기록·표시에만 쓴다 */
  name?: string;
}

export interface ProductImageDescription {
  /** 사진에서 읽어 낸 제품 이름. 못 읽으면 빈 문자열 */
  productName: string;
  /** 상표·제조자. 못 읽으면 빈 문자열 */
  brand: string;
  /** 모델명·제품 코드. 못 읽으면 빈 문자열 */
  modelName: string;
  /** 품목분류 질의에 그대로 쓰는 종합 서술 */
  description: string;
  /** 전기용품·생활용품·어린이제품 중 어디로 보이는가. 모르면 '알 수 없음' */
  guessedGroup: '전기용품' | '생활용품' | '어린이제품' | '알 수 없음';
  /** 안전과 관련될 만한 관찰 — 전원선·전지·삼킬 수 있는 작은 부품 등. 없으면 빈 문자열 */
  safetyNote: string;
  /** 사진이 흐리거나 제품을 못 알아본 경우 그 사실 */
  unreadableReason: string;
  model: string;
}

/*
  원본 프롬프트를 그대로 옮기지 않고 두 가지를 바꿨다.

  1) 자유 서술 대신 정해진 모양으로 받는다.
     원본은 「【PRODUCT IDENTIFICATION】…」 같은 머리글이 붙은 글을 받아 다음
     노드에서 다시 파싱한다. 모델이 머리글을 하나 빠뜨리면 그 뒤가 조용히
     어긋난다. 우리는 스키마로 강제한다(CLAUDE.md 의 구조화 출력 원칙).

  2) 「모르면 모른다고 적는다」를 칸으로 만든다.
     원본에도 "Cannot confirm"·"Image is unclear" 지침이 있는데, 자유 서술에서는
     그 말이 본문에 섞여 들어가 다음 단계가 그것을 제품 설명으로 읽는다.
     unreadable_reason 을 따로 두어 섞이지 않게 했다.
*/
const SYSTEM = `당신은 리콜된 제품의 사진을 보고 그 제품이 무엇인지 적는 판독원이다.
이 결과는 다음 단계에서 국제 품목분류(GPC) 코드를 찾는 질의로 쓰이고, 「전기용품 및
생활용품 안전관리법」과 「어린이제품 안전 특별법」 중 어느 쪽 대상인지 가리는 재료가 된다.

무엇을 보나
- 제품 이름·상표·모델명이 사진에 글자로 보이면 그대로 옮긴다. 안 보이면 빈 문자열로 둔다.
- description 에는 이 제품이 무엇이고 무엇에 쓰는 물건인지 두세 문장으로 적는다.
  재질·형태·크기·조작 방식(전기·전지·수동)처럼 분류에 도움이 되는 관찰 위주로 쓴다.
- safety_note 에는 전원선·플러그·전지·LED 같은 전기 부품, 삼킬 수 있는 작은 부품,
  36개월 미만 대상으로 보이는 특징처럼 안전과 관련된 관찰만 적는다. 없으면 빈 문자열.
- guessed_group 은 사진만으로 짐작되는 대분류다. 애매하면 '알 수 없음' 을 고른다 —
  틀린 대분류는 다음 단계 전체를 엉뚱한 곳으로 보낸다.

지키는 것
- 보이는 것만 적는다. 안 보이는 것을 추정해 채우지 않는다.
- 사진이 흐리거나 제품을 알아볼 수 없으면 unreadable_reason 에 그 사실을 적고,
  description 은 보이는 겉모습만 짧게 적는다. 그 경우 억지로 분류하지 않는다.
- 사진이 여러 장이면 같은 제품의 다른 각도로 보고 하나로 종합한다. 서로 다른
  제품이 섞여 있으면 가장 중심이 되는 제품 하나를 골라 적고 그 사실을 밝힌다.
- 모든 답은 한국어로 적는다.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'product_name', 'brand', 'model_name', 'description',
    'guessed_group', 'safety_note', 'unreadable_reason',
  ],
  properties: {
    product_name: { type: 'string', description: '사진에서 읽은 제품 이름. 없으면 빈 문자열' },
    brand: { type: 'string', description: '상표·제조자. 없으면 빈 문자열' },
    model_name: { type: 'string', description: '모델명·제품 코드. 없으면 빈 문자열' },
    description: { type: 'string', description: '무엇이고 무엇에 쓰는 물건인지 두세 문장' },
    guessed_group: {
      type: 'string',
      enum: ['전기용품', '생활용품', '어린이제품', '알 수 없음'],
      description: '사진만으로 짐작되는 대분류. 애매하면 알 수 없음',
    },
    safety_note: { type: 'string', description: '안전 관련 관찰. 없으면 빈 문자열' },
    unreadable_reason: {
      type: 'string',
      description: '사진이 흐리거나 알아볼 수 없을 때 그 사실. 문제가 없으면 빈 문자열',
    },
  },
};

interface RawOutput {
  product_name: string;
  brand: string;
  model_name: string;
  description: string;
  guessed_group: ProductImageDescription['guessedGroup'];
  safety_note: string;
  unreadable_reason: string;
}

/** 제품 사진 여러 장을 한 번에 읽어 하나의 서술로 만든다 */
export async function describeProductImages(
  images: ProductImage[],
  /** 공고에 적힌 제품명 등 이미 아는 것. 있으면 함께 준다 */
  known: { productName?: string | null; productDescription?: string | null } = {},
  target: { caseId?: number | null } = {},
): Promise<ProductImageDescription> {
  if (images.length === 0) throw new Error('사진이 없습니다');

  const cfg = openaiConfig();
  const user = [
    known.productName ? `공고에 적힌 제품명: ${known.productName}` : '',
    known.productDescription ? `공고에 적힌 설명: ${known.productDescription}` : '',
    `사진 ${images.length}장을 본다.`,
  ].filter(Boolean).join('\n');

  const { value } = await structuredVisionCall<RawOutput>({
    model: cfg.visionModel,
    system: SYSTEM,
    user,
    images: images.map((i) => ({ dataUrl: i.dataUrl })),
    schemaName: 'product_image_description',
    purpose: 'vision',
    caseId: target.caseId,
    schema: SCHEMA,
    effort: cfg.visionEffort as never,
  });

  return {
    productName: value.product_name,
    brand: value.brand,
    modelName: value.model_name,
    description: value.description,
    guessedGroup: value.guessed_group,
    safetyNote: value.safety_note,
    unreadableReason: value.unreadable_reason,
    model: cfg.visionModel,
  };
}

/**
 * 사진에서 읽은 서술을 품목분류 질의로 이어 붙인다.
 *
 * 공고의 짧은 제품명(「의자」)과 사진에서 읽은 서술을 **둘 다** 넣는다.
 * 사진만 쓰면 공고가 이미 정확히 말해 준 이름을 버리게 되고, 공고만 쓰면
 * 「의자」 석 자로 브릭을 고르게 된다.
 */
export async function assignGpcFromImages(
  images: ProductImage[],
  known: { productName?: string | null; productDescription?: string | null } = {},
  target: { caseId?: number | null } = {},
  candidateCount: number = DEFAULT_GPC_CANDIDATE_COUNT,
): Promise<{ image: ProductImageDescription; gpc: GpcAssignment }> {
  const image = await describeProductImages(images, known, target);

  const name = known.productName?.trim() || image.productName || '(제품명 미상)';
  const context = [
    known.productDescription?.trim() ? `공고 설명: ${known.productDescription.trim()}` : '',
    image.description ? `사진 판독: ${image.description}` : '',
    image.brand ? `상표: ${image.brand}` : '',
    image.modelName ? `모델: ${image.modelName}` : '',
    image.safetyNote ? `안전 관련 관찰: ${image.safetyNote}` : '',
  ].filter(Boolean).join('\n');

  const gpc = await findAndVerifyGpc(name, context, candidateCount, {
    caseId: target.caseId ?? null,
  });
  return { image, gpc };
}
