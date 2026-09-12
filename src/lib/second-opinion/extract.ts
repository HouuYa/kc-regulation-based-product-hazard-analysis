/**
 * 보고서가 스스로 말한 것을 뽑는다 (병행 점검 1단계)
 *
 * 무엇을 묻고 무엇을 묻지 않는가
 *   묻는 것   어떤 시험을 했는가 · 동일성 확인 결론이 무엇인가 · 최종 결론이 무엇인가
 *             · 측정값이 얼마인가 · 표시 관련 서술이 있는가
 *   묻지 않는 것  원인이 무엇인가. HF·DT 코드.
 *
 *   코드를 물으면 그것이 사실상 두 번째 case_tag 가 된다. 이 추출기의 일은
 *   "보고서가 무엇을 했고 무엇이라고 말했는가"를 인용해 오는 것뿐이고, 코드는
 *   ②의 규칙(legal.ts)과 ③의 통계(recall-evidence.ts)가 각자 붙인다.
 *   축을 나누면 어느 쪽이 틀렸는지 따로 고칠 수 있다.
 *
 * 왜 tagging.ts 의 runTagging() 을 그대로 쓰지 않는가
 *   그 함수의 다수결은 `hf_primary|dt_primary` 라는 단일 키로 센다. 여기 출력은
 *   집합(수행 시험 목록)이라 단일 키가 없어 다수결이 성립하지 않는다.
 *   철학은 그대로 가져온다 — 싼 모델을 여러 번 동시에 부르고, 답이 흔들리면
 *   상위 모델로 한 번 올린다. 반복 횟수·승격 문턱도 같은 tuning() 값을 쓴다.
 *   같은 성질의 값을 두 벌 만들지 않는다.
 *
 * evidence_span 강제의 세 겹
 *   1) 스키마에서 required        2) 프롬프트가 요약·재구성을 금지
 *   3) 저장 직전 부분문자열 검사   ← 기계가 판정하는 것은 이것뿐이다
 *   앞의 둘은 모델의 협조에 기대는 것이다. 통과 못 한 항목은 버리고 개수를 남긴다.
 */

import { structuredCall, type ReasoningEffort } from '../llm/client';
import { openaiConfig, tuning } from '../env';
import { sliceForExtraction, verifySpan } from './narrative';

export const PROMPT_VERSION = 'second-opinion/2026-09-11';

// ---------------------------------------------------------------------------
// 출력 모양
// ---------------------------------------------------------------------------

export interface TestPerformed {
  name: string;
  source_section: string;
  verdict: string;
  evidence_span: string;
}

export interface IdentityCheck {
  present: boolean;
  conclusion: string;
  differing_parts: string[];
  stated_impact: string;
  evidence_span: string;
}

export interface ConclusionOut {
  verdict: string;
  states_cause: boolean;
  is_non_target: boolean;
  evidence_span: string;
}

export interface MeasurementOut {
  label: string;
  value: string;
  unit: string;
  evidence_span: string;
}

export interface MarkingNote {
  note: string;
  evidence_span: string;
}

export interface InvestigationExtract {
  tests_performed: TestPerformed[];
  identity_check: IdentityCheck;
  conclusion: ConclusionOut;
  measurements: MeasurementOut[];
  marking_notes: MarkingNote[];
  extraction_note: string;
}

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'tests_performed', 'identity_check', 'conclusion',
    'measurements', 'marking_notes', 'extraction_note',
  ],
  properties: {
    tests_performed: {
      type: 'array',
      description:
        '보고서가 실제로 수행했다고 적은 시험. 「조사 방법」 줄의 괄호 안이 주 재료다. ' +
        '"현장 조사"·"동일성 확인"은 시험이 아니므로 넣지 않는다.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'source_section', 'verdict', 'evidence_span'],
        properties: {
          name: {
            type: 'string',
            description:
              '보고서에 적힌 시험명 그대로. 우리말로 바꾸거나 풀어 쓰지 않는다. ' +
              '"내습성, 누설전류 및 절연내력" 처럼 여러 시험이 한 묶음으로 적혀 있으면 ' +
              '시험 단위로 나눈다 — 이 경우 "내습성" 과 "누설전류 및 절연내력" 두 건이다.',
          },
          source_section: {
            type: 'string',
            enum: ['조사 방법', '제품 시험', '시험 결과', '결론', '기타'],
          },
          verdict: { type: 'string', enum: ['적합', '부적합', '판정없음', '미상'] },
          evidence_span: {
            type: 'string',
            description:
              '이 시험명이 나오는 문장을 원문 그대로 통째로 인용한다. 요약·재구성 금지. ' +
              '원문에서 글자 그대로 찾을 수 없는 문장은 버려진다.',
          },
        },
      },
    },
    identity_check: {
      type: 'object',
      additionalProperties: false,
      required: ['present', 'conclusion', 'differing_parts', 'stated_impact', 'evidence_span'],
      properties: {
        present: { type: 'boolean', description: '동일성 확인 절이 있는가' },
        conclusion: {
          type: 'string',
          enum: ['동일함', '상이함', '확인불가', '해당없음'],
          description:
            '그 문장이 최종적으로 무엇이라고 결론 내리는지만 본다. ' +
            '"식별 불가능한 부품을 제외하고 인증당시와 부품이 동일함" 은 동일함이다 — ' +
            '"불가" 라는 낱말이 있다고 확인불가로 보지 않는다. ' +
            '"인증 당시와 주요 부품 상이(PCB)" 처럼 실제로 다르다고 적었을 때만 상이함이다.',
        },
        differing_parts: {
          type: 'array',
          items: { type: 'string' },
          description: '상이함일 때 어느 부품이 다른지. 아니면 빈 배열',
        },
        stated_impact: {
          type: 'string',
          description:
            '조사관이 그 차이의 영향을 적었으면 그 문장을 인용한다 ' +
            '("화재에 영향을 끼치지 않았을 것으로 판단됨" 등). 없으면 빈 문자열',
        },
        evidence_span: { type: 'string', description: '원문 그대로 인용. 절이 없으면 빈 문자열' },
      },
    },
    conclusion: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'states_cause', 'is_non_target', 'evidence_span'],
      properties: {
        verdict: { type: 'string', enum: ['적합', '부적합', '원인미상', '비대상', '기타'] },
        states_cause: {
          type: 'boolean',
          description: '사고 원인을 특정해 서술했는가. 추정하지 말고 적혀 있는지만 본다',
        },
        is_non_target: {
          type: 'boolean',
          description: '"(비대상)" 처럼 적용할 안전기준이 없다고 적혀 있는가',
        },
        evidence_span: { type: 'string' },
      },
    },
    measurements: {
      type: 'array',
      description:
        '시험에서 **잰** 값만 담는다. 온도·전압·전류 측정 결과 등. ' +
        '시험 조건(가한 충격 에너지, 타격 횟수, 투입 시간처럼 시험을 위해 정해 놓은 값)은 ' +
        '측정값이 아니므로 담지 않는다. 없으면 빈 배열',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value', 'unit', 'evidence_span'],
        properties: {
          label: { type: 'string', description: '무엇을 잰 값인가 ("이상운전 시험 최대 온도" 등)' },
          value: { type: 'string', description: '숫자를 문자열로. 범위면 "40~90" 처럼 원문대로' },
          // K 는 온도「상승」의 단위다. 온도상승 시험 결과가 이 단위로 적히는데
          // 목록에 없어서 전부 「기타」로 떨어지고 있었다(실측 14건)
          unit: { type: 'string', enum: ['℃', 'K', 'V', 'A', 'W', 'kW', 'mA', 'MΩ', 'N', 'mm', '%', '기타'] },
          evidence_span: { type: 'string' },
        },
      },
    },
    marking_notes: {
      type: 'array',
      description:
        '표시·경고문·사용설명서 관련 서술. 미표시·누락·미획득 같은 말이 있을 때만 담는다. ' +
        '없으면 빈 배열',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['note', 'evidence_span'],
        properties: { note: { type: 'string' }, evidence_span: { type: 'string' } },
      },
    },
    extraction_note: {
      type: 'string',
      description: '구역을 못 찾았거나 판단이 어려웠으면 그 사실. 없으면 빈 문자열',
    },
  },
};

const SYSTEM = `당신은 제품 사고조사보고서를 읽고 "이 보고서가 실제로 무엇을 했는지"를 뽑아내는 추출기다.

가장 중요한 규칙
- 당신은 사고 원인을 판단하지 않는다. 보고서에 적힌 사실만 인용해 온다.
- evidence_span 은 원문에서 글자 그대로 인용한다. 요약하거나 다듬지 않는다.
  원문에서 찾을 수 없는 인용은 기계 검사에서 버려지고, 그 항목도 함께 사라진다.
- 원문에 없는 것은 만들지 않는다. 해당 구역이 없으면 빈 배열·빈 문자열로 둔다.

수행한 시험을 뽑을 때
- 「조사 방법」 줄이 주 재료다. 실측상 보고서 99%에 이 줄이 있다.
  예: "조사 방법 : 현장 조사, 동일성 확인, 제품시험(내습성, 누설전류 및 절연내력)"
  → 시험은 "내습성" 과 "누설전류 및 절연내력" 두 건이다.
    "현장 조사"와 "동일성 확인"은 시험이 아니므로 넣지 않는다.
- 괄호 안이 쉼표로 이어져 있으면 시험 단위로 나눈다. 다만 "및"으로 묶인 것은
  한 시험의 이름일 수 있으므로 원문의 묶음을 존중한다.
- PDF 에서 뽑은 글이라 줄이 문장 한복판에서 끊긴다. 끊긴 뒤쪽에 이어지는 시험명도 찾는다.
- 「제품시험」·「안전기준시험」·「결함조사」는 모두 시험을 담는 말이다.

판정(verdict)을 정할 때
- 그 시험이 적합이었는지 부적합이었는지가 적혀 있으면 그대로 쓴다.
- "제품 시험 결과 모두 관련 규격상 요구사항을 충족" 처럼 뭉뚱그린 결론뿐이면
  그 결론을 각 시험의 판정으로 쓴다.
- 아무 판정도 없으면 판정없음이다. 추측해서 적합이라고 쓰지 않는다.

동일성 확인을 읽을 때 — 여기서 가장 많이 틀린다
- 문장이 최종적으로 무엇이라고 결론 내리는지만 본다. 낱말이 아니라 결론이다.
- "식별 불가능한 부품을 제외하고 인증당시와 부품이 동일함" → 동일함
- "인증당시와 비교하여 전지 정격이 불일치함" → 상이함
- "인증 당시와 주요 부품 상이 (PCB)" → 상이함`;

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

export interface ExtractResult {
  value: InvestigationExtract;
  /** 반복 호출의 시험명 집합 일치도 (Jaccard) */
  agreement: number;
  model: string;
  escalated: boolean;
  callCount: number;
  /** 인용 검사에서 버린 항목 수 */
  droppedSpans: number;
  /** 버린 인용 그 자체 — 진단용 */
  droppedTexts: string[];
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number };
}

/**
 * 시험명 앞에 붙은 조항 번호를 떼어 낸다.
 *
 * 보고서가 「4.1 유해원소 용출 시험」·「4.15.1.1 측면 안정성 시험」처럼 조항 번호를
 * 그대로 인용하는 일이 있다(실측 47건 중 7건). 번호가 붙어 있으면 제목 일치가
 * 깨지는데, 정작 그 번호는 **조항을 정확히 가리키는 지시자**라 떼어서 따로 쓴다.
 */
export function splitClauseMarker(s: string): { marker: string | null; rest: string } {
  const m = s.match(/^\s*(\d+(?:\.\d+)*)\s+(.*)$/);
  return m ? { marker: m[1], rest: m[2] } : { marker: null, rest: s };
}

/**
 * 반복 호출이 같은 시험 목록을 냈는지 견주기 위한 정규화.
 *
 * 「시험」 꼬리를 떼는 이유는 한 번은 "온도상승", 다음엔 "온도상승 시험" 이라고
 * 적는 흔들림을 같은 것으로 보기 위해서다. **조항에 맞출 때는 쓰지 않는다** —
 * 아래 matchableTestName 주석 참고.
 */
export function normalizeTestName(s: string): string {
  return splitClauseMarker(s)
    .rest
    .replace(/\([^)]*\)/g, ' ')
    .replace(/시험$/u, ' ')
    .replace(/[^가-힣A-Za-z0-9]+/g, ' ')
    .trim();
}

/**
 * 조항 제목에 맞추기 위한 정규화. 「시험」 꼬리를 **떼지 않는다.**
 *
 * 왜 떼면 안 되는가 (070 구현 중 실측으로 잡았다)
 *   부속서 계열 기준은 title_raw 에 제목이 아니라 조항 본문이 통째로 들어 있다.
 *     5.3.8  "저온시험 6.7항에 따라 -40 °C에서 7시간 동안 시험한 뒤에도 정상…"
 *   접두 일치가 잘 맞을 구조인데, 시험명에서 꼬리를 떼면 「저온시험」이 「저온」
 *   두 글자가 되어 최소 길이에 걸려 스스로 막힌다. 실제로 스케이트보드 사건의
 *   저온·고온 시험 6건이 전부 이렇게 사라졌다.
 *
 *   떼지 않아도 손해가 없다. 접두 일치는 짧은 쪽이 긴 쪽의 앞머리이기만 하면 되므로
 *   「기계적 강도 시험」과 「기계적 강도」는 어느 쪽이 길든 걸린다.
 */
export function matchableTestName(s: string): string {
  return splitClauseMarker(s)
    .rest
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^가-힣A-Za-z0-9]+/g, ' ')
    .trim();
}

/**
 * 집합 일치도.
 *
 * 단일 코드가 아니라 집합이므로 다수결 대신 Jaccard 를 쓴다. 반복 호출이 같은
 * 시험 목록을 냈는지가 이 추출기에서 흔들리는지를 보는 지표다.
 */
function jaccardAgreement(attempts: InvestigationExtract[]): number {
  if (attempts.length <= 1) return 1;
  const sets = attempts.map(
    (a) => new Set(a.tests_performed.map((t) => normalizeTestName(t.name)).filter(Boolean)),
  );
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const inter = [...sets[i]].filter((x) => sets[j].has(x)).length;
      const union = new Set([...sets[i], ...sets[j]]).size;
      total += union === 0 ? 1 : inter / union;
      pairs++;
    }
  }
  return pairs === 0 ? 1 : total / pairs;
}

/** 가장 많은 시험을 찾아낸 답을 고른다. 집합이라 다수결 대신 "가장 많이 건진 쪽"이다 */
function richest(attempts: InvestigationExtract[]): InvestigationExtract {
  return [...attempts].sort(
    (a, b) => b.tests_performed.length - a.tests_performed.length,
  )[0];
}

/**
 * 인용이 원문에 실제로 있는지 검사해 걸러 낸다 (선 4 의 집행).
 *
 * 항목을 통째로 버린다. 인용을 못 대는 항목은 근거가 없다는 뜻이고, 근거 없는
 * 항목을 "인용만 비워서" 남기면 화면에서 근거 있는 것과 구분되지 않는다.
 */
function enforceSpans(
  narrative: string,
  v: InvestigationExtract,
): { value: InvestigationExtract; dropped: number; droppedSpans: string[] } {
  let dropped = 0;
  // 무엇을 버렸는지 남긴다. 개수만 세면 "모델이 못 찾았다"와 "찾았는데 우리가
  // 버렸다"를 구분할 수 없다 — 실제로 4건에서 이 구분이 필요했다
  const droppedSpans: string[] = [];

  const keep = <T extends { evidence_span: string }>(items: T[]): T[] =>
    items.filter((it) => {
      const ok = verifySpan(narrative, it.evidence_span);
      if (!ok) {
        dropped++;
        droppedSpans.push(it.evidence_span);
      }
      return ok;
    });

  /**
   * 수행한 시험은 인용이 아니라 **시험명 자체**가 원문에 있는지로 판정한다.
   *
   * 왜 다르게 보는가 (실측으로 고쳤다)
   *   인용 한 구절이 글자 그대로 맞아야 한다고 두었더니, 사건 4건에서 수행한 시험이
   *   통째로 사라졌다. 모델이 시험을 못 찾은 것이 아니라 인용을 조금 다르게 적었을
   *   뿐이었다 — 같은 사건을 다시 돌리자 정상으로 나왔다. 실행마다 흔들리는 것이다.
   *
   *   그런데 그 손해는 그냥 누락이 아니다. 수행한 시험이 사라지면 그 절이 「시험하지
   *   않은 구간」으로 올라간다. **조사관이 실제로 한 일을 안 했다고 말하는 것**이고,
   *   띄어쓰기 때문에 온도상승이 공백 1위로 나왔던 것과 같은 종류의 거짓이다.
   *
   *   시험명은 짧고 원문에 그대로 적혀 있다("제품시험(온도상승, 이상운전)").
   *   이름이 원문에 있으면 그 시험은 실재한다 — 지어낸 것을 막는다는 목적은 그대로
   *   지키면서, 인용 한 줄의 흔들림에 시험을 잃지 않는다.
   */
  const flat = narrative.replace(/\s+/g, '');
  const keepTests = (items: TestPerformed[]): TestPerformed[] =>
    items.filter((t) => {
      const nameInSource = flat.includes(t.name.replace(/\s+/g, ''));
      const spanOk = verifySpan(narrative, t.evidence_span);
      if (!nameInSource && !spanOk) {
        dropped++;
        droppedSpans.push(`${t.name} — ${t.evidence_span}`);
        return false;
      }
      return true;
    });

  const identityOk = v.identity_check.present && verifySpan(narrative, v.identity_check.evidence_span);
  if (v.identity_check.present && !identityOk) {
    dropped++;
    droppedSpans.push(v.identity_check.evidence_span);
  }

  const conclusionOk = verifySpan(narrative, v.conclusion.evidence_span);
  if (!conclusionOk) {
    dropped++;
    droppedSpans.push(v.conclusion.evidence_span);
  }

  return {
    value: {
      tests_performed: keepTests(v.tests_performed),
      identity_check: identityOk
        ? v.identity_check
        : { present: false, conclusion: '해당없음', differing_parts: [], stated_impact: '', evidence_span: '' },
      // 결론은 버리지 않고 인용만 비운다 — "결론이 없다"와 "인용을 못 댔다"는 다르고,
      // 화면이 span_verified=false 로 등급을 낮춰 보여 준다
      conclusion: conclusionOk ? v.conclusion : { ...v.conclusion, evidence_span: '' },
      measurements: keep(v.measurements),
      marking_notes: keep(v.marking_notes),
      extraction_note: v.extraction_note,
    },
    dropped,
    droppedSpans,
  };
}

export async function extractInvestigation(
  event: { id?: number | null; itemName: string | null; title: string | null; narrative: string },
): Promise<ExtractResult> {
  const cfg = openaiConfig();
  const t = tuning();
  const slice = sliceForExtraction(event.narrative);

  /*
    고정 부분을 앞에, 사건별 축약본을 뒤에 둔다.

    tagCase() 와 같은 이유다 — 프롬프트 앞부분이 글자 그대로 같으면 그 구간이
    1/10 단가로 청구된다(056). 다만 이쪽은 코드 목록 2,500토큰이 없어서 원래
    태깅보다 훨씬 싸다.
  */
  const user = [
    '[이 보고서에서 읽을 구역만 추려 놓은 것이다. 「…」 는 중간이 잘렸다는 표시다]',
    '',
    event.itemName ? `품목: ${event.itemName}` : '',
    event.title ? `제목: ${event.title}` : '',
    '',
    slice,
  ]
    .filter((x) => x !== '')
    .join('\n');

  const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const call = async (model: string, effort: string) => {
    const r = await structuredCall<InvestigationExtract>({
      model,
      system: SYSTEM,
      user,
      schemaName: 'investigation_extract',
      purpose: 'second_opinion',
      caseId: event.id ?? null,
      schema: SCHEMA,
      effort: effort as ReasoningEffort,
    });
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.reasoningTokens += r.usage.reasoningTokens;
    return r.value;
  };

  // 1차 — 싼 모델을 동시에 여러 번. 서로의 결과를 재료로 쓰지 않으므로 순서가 없다
  const attempts = await Promise.all(
    Array.from({ length: Math.max(1, t.bulkRepeat) }, () => call(cfg.bulkModel, cfg.bulkEffort)),
  );

  const agreement = jaccardAgreement(attempts);
  let chosen = richest(attempts);
  let model = cfg.bulkModel;
  let escalated = false;

  // 2차 — 시험 목록이 흔들린 건만 상위 모델에 다시 묻는다
  if (agreement < t.escalateBelowAgreement) {
    chosen = await call(cfg.escalateModel, cfg.escalateEffort);
    attempts.push(chosen);
    model = cfg.escalateModel;
    escalated = true;
  }

  const { value, dropped, droppedSpans } = enforceSpans(event.narrative, chosen);

  return {
    value,
    // 저장하는 일치도는 1차 값이다 — 승격했다고 해서 그 보고서가 덜 애매해지는 것은 아니다
    agreement,
    model,
    escalated,
    callCount: attempts.length,
    droppedSpans: dropped,
    droppedTexts: droppedSpans,
    usage,
  };
}
