/**
 * 품목분류 한 자리 — 무엇에 붙이든 이 함수를 지난다
 *
 * 왜 만들었나 (담당자 요청, 2026-09-09)
 *   "만들어진 GPC 부여가 다른 곳도 사용할 수 있도록 해 주세요."
 *   "보다 일반적으로 만들면서 보강해 주세요."
 *
 *   지금까지 품목분류는 세 군데에서 각자 조립됐다 — 안전기준(tag-standards-gpc),
 *   사고보고서(load-cases), 품목 사전(assign-term-gpc). 조회+검증 오케스트레이션은
 *   findAndVerifyGpc() 로 공유했지만, 그 앞뒤(무엇을 질의문으로 조립할지, 결과를
 *   어디에 어떤 모양으로 남길지)는 여전히 각자였다. 그래서 「AI 가 품목분류를 어떻게
 *   붙이고 있나」를 한 번에 볼 수 없었고, 새 호출부를 붙일 때마다 같은 조립을 다시 썼다.
 *
 * 이 함수가 하는 여섯 걸음
 *   0. 이미 신고된 코드가 있으면 그것을 읽고 끝낸다 — AI 를 부르지 않는다  from-registered.ts
 *   1. (사진이 있으면) 사진을 읽어 제품 서술을 얻는다        describe-image.ts
 *   2. 벡터 색인에서 후보를 가져온다 — 질의문을 함께 돌려받는다  lookup.ts
 *   3. 계위를 한 단계씩 내려가며 판정한다                     verify.ts
 *   4. 브릭이 붙었으면 국내 안전관리 갈래로 되짚는다           domestic.ts
 *   5. 무엇으로 찾아 무엇을 골랐는지 이력에 남긴다             gpc_assignment(064)
 *
 * 0번은 담당자 지적으로 보탰다 (065)
 *   "OECD 포털이 보내는 코드는 각 나라들이 등록할 때 사용하는 코드로 신빙성이
 *   매우 높습니다." 신고된 값을 놔두고 우리가 추정할 이유가 없다. 등록국은 자기
 *   리콜을 조사한 쪽이고, 우리는 제품명 몇 글자로 짐작하는 쪽이다.
 *
 * 4번도 이번에 보탠 것이다
 *   협회 워크플로는 GPC 코드에서 끝난다. 우리는 그 코드가 **국내에서 무엇을
 *   뜻하는지**까지 간다 — 표준 제품분류체계(K-GPC)는 브릭에 속성을 더해
 *   대분류·인증구분·법정 품목을 정하는 체계이고, 그 대응표를 우리가 이미 갖고 있다.
 *   담당자가 실제로 알고 싶은 것은 「10002225」가 아니라 「이건 어린이제품이고
 *   안전확인 대상인가」다.
 *
 * 이력은 실패해도 본 일을 막지 않는다
 *   기록은 되짚기 위한 것이지 판정의 일부가 아니다. 기록에 실패했다고 이미 받아 낸
 *   판정을 버리면 AI 호출값만 날린다. 그래서 기록 실패는 로그만 남기고 넘어간다.
 */

import { findAndVerifyGpc, DEFAULT_GPC_CANDIDATE_COUNT } from './assign';
import { lookupDomestic, type DomesticLookup } from './domestic';
import { describeProductImages, type ProductImage, type ProductImageDescription } from './describe-image';
import { recordGpcAssignment, type GpcSubject } from './record';
import { verificationFromRegistered, type RegisteredCodes } from './from-registered';
import type { GpcSource } from './provenance';
import type { GpcCandidate } from './lookup';
import type { GpcVerification } from './verify';

export interface ClassifyInput {
  /** 제품명·품목명·기준명. 짧아도 된다 */
  name: string;
  /** 적용범위·사고 서술·리콜 설명 등 아는 것을 모은 서술 */
  context?: string | null;
  /** 제품 사진. 있으면 읽어서 서술에 보탠다 */
  images?: ProductImage[];
  /** 무엇에 붙이는 것인가. 이력에 남는다 */
  subject: GpcSubject;
  /** 후보를 몇 개까지 볼 것인가. 좁히면 정답이 후보 밖으로 밀린다 */
  candidateCount?: number;
  /** 국내 안전관리 되짚기를 건너뛸 때. 기본은 한다 */
  skipDomestic?: boolean;
  /**
   * 이미 신고된 코드가 있으면 여기에 준다 — 있으면 AI 를 부르지 않는다.
   *
   * 담당자 지적(2026-09-09): "OECD 포털이 보내는 코드는 각 나라들이 등록할 때
   * 사용하는 코드로 신빙성이 매우 높습니다." 신고된 값을 놔두고 우리가 추정할
   * 이유가 없다. 값도 시간도 아끼고, 무엇보다 더 나은 답이다.
   */
  registered?: RegisteredCodes | null;
  /** registered 를 쓸 때 그 출처. 기본은 우리 판정(OUR_AI) */
  source?: GpcSource;
}

export interface ClassifyResult {
  verification: GpcVerification;
  candidates: GpcCandidate[];
  queryText: string;
  /** 이 판정이 어디서 왔는가 */
  source: GpcSource;
  /** 브릭이 붙고 되짚기를 했을 때만 있다 */
  domestic: DomesticLookup | null;
  /** 사진을 읽었을 때만 있다 */
  imageReading: ProductImageDescription | null;
}

export async function classifyProduct(input: ClassifyInput): Promise<ClassifyResult> {
  const candidateCount = input.candidateCount ?? DEFAULT_GPC_CANDIDATE_COUNT;

  /*
    0. 신고된 코드가 있으면 거기서 끝난다 (065)

    등록국이 자기 리콜을 OECD 포털에 올리며 직접 고른 코드다 — 제품을 실제로
    조사한 쪽이 붙인 값이라 우리 임베딩+LLM 추정보다 낫다. AI 를 부르지 않으므로
    후보 목록도 질의문도 없고, 이력에는 「신고된 코드를 읽었다」로 남는다.

    카탈로그에서 코드를 못 찾으면(다른 판일 수 있다) null 이 돌아온다. 그때는
    아래의 평소 경로로 내려가 우리가 붙인다 — 신고 코드가 있다는 이유로 아무것도
    못 붙인 채 끝내지 않는다.
  */
  const registeredSource = input.source ?? 'OUR_AI';
  if (input.registered && registeredSource !== 'OUR_AI') {
    const fromRegistered = await verificationFromRegistered(input.registered, registeredSource);
    if (fromRegistered && fromRegistered.level !== 'NONE') {
      let domesticFromRegistered: DomesticLookup | null = null;
      if (!input.skipDomestic && fromRegistered.brickCode) {
        try {
          domesticFromRegistered = await lookupDomestic(fromRegistered.brickCode);
        } catch (e) {
          console.error('국내 안전관리 되짚기 실패:', e);
        }
      }
      try {
        await recordGpcAssignment({
          subject: input.subject,
          queryText: '',
          candidates: [],
          verification: fromRegistered,
          source: registeredSource,
          publication: input.registered.publication ?? null,
        });
      } catch (e) {
        console.error('품목분류 이력 기록 실패:', e);
      }
      return {
        verification: fromRegistered,
        candidates: [],
        queryText: '',
        source: registeredSource,
        domestic: domesticFromRegistered,
        imageReading: null,
      };
    }
  }

  // 1. 사진이 있으면 먼저 읽는다. 공고의 짧은 제품명(「의자」)만으로는
  //    벡터 색인이 엉뚱한 브릭을 물어 오기 때문이다.
  let imageReading: ProductImageDescription | null = null;
  if (input.images && input.images.length > 0) {
    imageReading = await describeProductImages(
      input.images,
      { productName: input.name, productDescription: input.context },
      { caseId: input.subject.type === 'CASE' ? Number(input.subject.key) : null },
    );
  }

  // 2~3. 아는 것을 모두 넣는다. 사진만 쓰면 공고가 이미 정확히 말해 준 이름을
  //      버리게 되고, 공고만 쓰면 석 자로 브릭을 고르게 된다.
  const context = [
    input.context?.trim() || '',
    imageReading?.description ? `사진 판독: ${imageReading.description}` : '',
    imageReading?.brand ? `상표: ${imageReading.brand}` : '',
    imageReading?.modelName ? `모델: ${imageReading.modelName}` : '',
    imageReading?.safetyNote ? `안전 관련 관찰: ${imageReading.safetyNote}` : '',
  ].filter(Boolean).join('\n');

  const name = input.name?.trim() || imageReading?.productName || '(제품명 미상)';

  const { verification, candidates, queryText } = await findAndVerifyGpc(
    name,
    context || name,
    candidateCount,
    {
      caseId: input.subject.type === 'CASE' ? Number(input.subject.key) : null,
      standardId: input.subject.type === 'STANDARD' ? Number(input.subject.key) : null,
    },
  );

  // 4. 브릭까지 좁혔을 때만 되짚는다. 클래스·패밀리로는 인증구분이 안 정해진다
  let domestic: DomesticLookup | null = null;
  if (!input.skipDomestic && verification.level === 'BRICK' && verification.brickCode) {
    try {
      domestic = await lookupDomestic(verification.brickCode);
    } catch (e) {
      console.error('국내 안전관리 되짚기 실패:', e);
    }
  }

  // 5. 이력. 실패해도 판정은 그대로 돌려준다
  try {
    await recordGpcAssignment({
      subject: input.subject,
      queryText,
      candidates,
      verification,
      imageReading,
      source: 'OUR_AI',
    });
  } catch (e) {
    console.error('품목분류 이력 기록 실패:', e);
  }

  return { verification, candidates, queryText, source: 'OUR_AI', domestic, imageReading };
}
