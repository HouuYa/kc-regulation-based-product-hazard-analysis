/**
 * GPC 후보 검증 — LLM으로 임베딩 후보 중 실제로 맞는 것을 고른다
 *
 * findGpcCandidates() 는 임베딩 유사도 순위만 준다. 라운드 10 실측(KC안전기준
 * 5건)에서 이 순위를 그대로 믿을 수 없다는 게 드러났다 — 절대 유사도가 낮고
 * (0.25~0.4대) 후보 안에 정답이 있어도 순위가 밀려 있는 경우가 있었다.
 *
 * Brick→Class→Family→Segment 단계적 하향 (라운드 11 보강)
 *   처음엔 "Brick이 명확히 맞으면 확정, 아니면 NONE" 이분법으로 만들었는데,
 *   담당자가 이 협회의 실제 운영 파이프라인(해외리콜 OECD 일일 처리 —
 *   docs/OECD리콜등록/(GS1) [한국리콜__OECD] OECD GPC RAG.json,
 *   recalls_oecd_staging.assignedGpc{Brick,Class,Family,Segment}Code)을
 *   짚어 줬다. 그 파이프라인은 oecd_gpc_202405 를 그대로 쓰되(우리와 동일
 *   데이터), Brick이 후보와 명확히 일치하지 않으면 포기하지 않고 후보의
 *   상위 계층(Class→Family→Segment)으로 단계적으로 내려가며 답한다 —
 *   "정확한 Brick은 아니지만 적어도 이 대분류에는 속한다"는 정보가
 *   아무것도 없는 것보다는 유용하기 때문이다. 이 파일도 같은 원칙을
 *   따른다: brick_code 를 후보 목록의 enum 으로 고정해 코드를 지어내지
 *   못하게 막는 것(tagging.ts와 같은 원리)은 그대로 두되, Brick/Class/
 *   Family/Segment 코드를 모두 하나의 enum 에 넣고 어느 계층을 골랐는지는
 *   서버 쪽에서 후보 목록과 대조해 결정론적으로 판정한다(모델의 자기보고
 *   계층 이름을 그대로 믿지 않는다 — 코드와 계층이 어긋나는 사고를 막는다).
 */

import { structuredCall, type ReasoningEffort } from '../llm/client';
import { openaiConfig } from '../env';
import type { GpcCandidate } from './lookup';

export type GpcMatchLevel = 'BRICK' | 'CLASS' | 'FAMILY' | 'SEGMENT' | 'NONE';

/**
 * Brick 하나는 정확히 하나의 Class/Family/Segment 에 속한다(GPC 계층 구조).
 * recalls_oecd_staging(해외리콜 OECD 파이프라인)이 assignedGpcBrickCode 와
 * assignedGpcSegmentCode/FamilyCode/ClassCode 를 항상 함께 저장하는 것과
 * 같은 이유다 — Brick 까지 확정됐어도 그 상위 계층 코드를 따로 또 찾을 필요
 * 없이 같은 후보 행에서 그대로 나온다. level 보다 아래 계층 필드는 null 이다
 * (예: level='CLASS' 면 classCode 이하는 채워지고 brickCode 는 null).
 */
export interface GpcVerification {
  level: GpcMatchLevel;
  segmentCode: string | null;
  segmentTitle: string | null;
  familyCode: string | null;
  familyTitle: string | null;
  classCode: string | null;
  classTitle: string | null;
  brickCode: string | null;
  brickTitle: string | null;
  confidenceScore: number;
  reasoning: string;
  model: string;
  candidateCount: number;
}

interface VerifyOutput {
  selected_code: string;
  confidence_score: number;
  reasoning: string;
}

function renderCandidates(candidates: GpcCandidate[]): string {
  return candidates
    .map(
      (c) =>
        `${c.rank}. Brick ${c.brickCode} "${c.brickTitle}" ` +
        `< Class ${c.classCode} "${c.classTitle}" ` +
        `< Family ${c.familyCode} "${c.familyTitle}" ` +
        `< Segment ${c.segmentCode} "${c.segmentTitle}" (유사도 ${c.similarity.toFixed(3)})`,
    )
    .join('\n');
}

const SYSTEM = `당신은 어떤 대상(제품·안전기준 문서)이 실제로 어떤 GPC(GS1 국제 품목분류) 코드에
해당하는지 검증하는 판정기다. 후보 목록은 Brick(가장 구체적) < Class < Family <
Segment(가장 포괄적) 계층으로 주어진다.

판정 순서 (엄격한 적합성 평가 — 반드시 이 순서로 시도한다)
1. 먼저 Brick 코드 후보들을 본다. 어떤 Brick 이 대상의 핵심 기능·주요 특성·일반적인
   용도와 명확하고 구체적으로 일치하면 그 brick_code 를 selected_code 로 고른다.
2. 어떤 Brick 도 충분히 구체적으로 일치하지 않으면(예: 포괄적이거나 다른 유형의
   제품을 가리키는 경우) Brick 을 포기하고, 그중 가장 관련성 높은 후보의 Class 코드를
   selected_code 로 고른다.
3. Class 도 맞지 않으면 Family 코드로, Family 도 맞지 않으면 Segment 코드로 한 단계씩
   더 내려간다.
4. Segment 조차 대상과 무관하면 selected_code 는 'NONE' 이다.

규칙
- selected_code 는 반드시 제시된 후보 목록에 나온 코드(Brick/Class/Family/Segment
  중 하나) 또는 'NONE' 만 고른다. 목록에 없는 코드는 어떤 경우에도 만들지 않는다.
- 순위(유사도)에 얽매이지 말고, 대상이 실제로 무엇을 규율·서술하는 제품인지와 각
  후보의 명칭·정의를 비교해서 판단한다. 순위가 낮아도 실제로 맞는 후보를 고른다.
- reasoning 에는 어느 계층까지 내려갔는지와 왜인지(Brick 후보가 왜 부적합했는지 등)를
  한두 문장으로 남긴다.
- 확신이 없으면 confidence_score 를 낮게 주고, 상위 계층으로 내려가거나 NONE 을
  고르는 것을 주저하지 않는다. 후보 중 억지로 가장 비슷해 보이는 Brick 을 고르지
  않는다 — 틀린 Brick 을 확정하는 것보다 정직한 Class/Family/Segment 나 NONE 이 낫다.`;

/**
 * @param productContext 품목명·기준명·적용범위·정의 등을 조합한 서술 텍스트
 * @param candidates findGpcCandidates() 가 준 후보(넓게, 10~20개 권장 — 좁으면
 *   정답이 후보에 없을 수 있다)
 */
export async function verifyGpcMatch(
  productContext: string,
  candidates: GpcCandidate[],
  /** 무엇에 품목분류를 붙이다 부른 것인가. 기록에 남긴다(054) */
  target: { caseId?: number | null; standardId?: number | null } = {},
): Promise<GpcVerification | null> {
  if (candidates.length === 0) return null;

  const cfg = openaiConfig();

  // Brick/Class/Family/Segment 코드를 전부 모아 하나의 enum 으로 만든다.
  // 같은 코드가 여러 후보에 걸쳐 중복될 수 있어 Set 으로 정리한다.
  const codeSet = new Set<string>();
  for (const c of candidates) {
    codeSet.add(c.brickCode);
    codeSet.add(c.classCode);
    codeSet.add(c.familyCode);
    codeSet.add(c.segmentCode);
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['selected_code', 'confidence_score', 'reasoning'],
    properties: {
      selected_code: {
        type: 'string',
        enum: [...codeSet, 'NONE'],
      },
      confidence_score: { type: 'number', description: '0.0~1.0 자기보고 확신도' },
      reasoning: {
        type: 'string',
        description: '어느 계층까지 내려갔는지, 왜 그 코드를(또는 NONE을) 골랐는지 한두 문장 근거',
      },
    },
  };

  const user = [
    '[대상]',
    productContext,
    '',
    '[GPC 후보 (Brick < Class < Family < Segment, 임베딩 유사도 순)]',
    renderCandidates(candidates),
  ].join('\n');

  const { value } = await structuredCall<VerifyOutput>({
    model: cfg.rerankModel,
    system: SYSTEM,
    user,
    schemaName: 'gpc_verification', purpose: 'gpc_verify',
    caseId: target.caseId, standardId: target.standardId,
    schema,
    effort: cfg.rerankEffort as ReasoningEffort,
  });

  const resolved = resolveHierarchy(value.selected_code, candidates);

  return {
    ...resolved,
    confidenceScore: value.confidence_score,
    reasoning: value.reasoning,
    model: cfg.rerankModel,
    candidateCount: candidates.length,
  };
}

/**
 * 모델이 고른 코드가 후보 목록의 어느 계층과 일치하는지, 그리고 그 코드가
 * 속한 상위 계층 전체(Segment/Family/Class)를 서버가 직접 판정해 채운다.
 *
 * 모델의 자기보고를 믿지 않는 이유는 tagging.ts 의 validateCodes() 와 같다 —
 * 구조화 출력이 스키마는 지켜도 "이게 Brick인지 Class인지"·"그 상위 계층이
 * 뭔지"까지 매번 정확히 보고한다는 보장은 없으므로, 우리가 이미 가진 후보
 * 목록(각 행이 Brick~Segment 전체를 담고 있다)에서 직접 찾는다. Brick 부터
 * 확인하는 이유는 더 구체적인 계층을 우선하기 위함이다(GPC 코드 체계상 같은
 * 코드값이 계층 간에 겹치지는 않는다).
 */
function resolveHierarchy(
  code: string,
  candidates: GpcCandidate[],
): Pick<
  GpcVerification,
  'level' | 'segmentCode' | 'segmentTitle' | 'familyCode' | 'familyTitle' | 'classCode' | 'classTitle' | 'brickCode' | 'brickTitle'
> {
  const empty = {
    segmentCode: null, segmentTitle: null,
    familyCode: null, familyTitle: null,
    classCode: null, classTitle: null,
    brickCode: null, brickTitle: null,
  };

  if (code !== 'NONE') {
    const brickMatch = candidates.find((c) => c.brickCode === code);
    if (brickMatch) {
      return {
        level: 'BRICK',
        segmentCode: brickMatch.segmentCode, segmentTitle: brickMatch.segmentTitle,
        familyCode: brickMatch.familyCode, familyTitle: brickMatch.familyTitle,
        classCode: brickMatch.classCode, classTitle: brickMatch.classTitle,
        brickCode: brickMatch.brickCode, brickTitle: brickMatch.brickTitle,
      };
    }
    const classMatch = candidates.find((c) => c.classCode === code);
    if (classMatch) {
      return {
        level: 'CLASS',
        segmentCode: classMatch.segmentCode, segmentTitle: classMatch.segmentTitle,
        familyCode: classMatch.familyCode, familyTitle: classMatch.familyTitle,
        classCode: classMatch.classCode, classTitle: classMatch.classTitle,
        brickCode: null, brickTitle: null,
      };
    }
    const familyMatch = candidates.find((c) => c.familyCode === code);
    if (familyMatch) {
      return {
        level: 'FAMILY',
        segmentCode: familyMatch.segmentCode, segmentTitle: familyMatch.segmentTitle,
        familyCode: familyMatch.familyCode, familyTitle: familyMatch.familyTitle,
        classCode: null, classTitle: null,
        brickCode: null, brickTitle: null,
      };
    }
    const segmentMatch = candidates.find((c) => c.segmentCode === code);
    if (segmentMatch) {
      return {
        level: 'SEGMENT',
        segmentCode: segmentMatch.segmentCode, segmentTitle: segmentMatch.segmentTitle,
        familyCode: null, familyTitle: null,
        classCode: null, classTitle: null,
        brickCode: null, brickTitle: null,
      };
    }
  }

  return { level: 'NONE', ...empty };
}
