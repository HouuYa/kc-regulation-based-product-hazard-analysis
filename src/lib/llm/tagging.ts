/**
 * L1 조항 태깅 · L2 사건 코드화 (설계문서 §5.2)
 *
 * 이 파일이 지키는 것 세 가지
 *
 *  1) 코드는 코드북에서 뽑은 enum 으로 고정한다 (§5.2.2)
 *     LLM 이 "HF.M.TIP_OVER" 같은 없는 코드를 지어내는 것을 원천 차단한다.
 *     스키마를 통과해도 저장 전에 resolve_code() 로 한 번 더 검증한다.
 *
 *  2) evidence_span 을 required 로 둔다 (§5.2.2)
 *     근거 없는 코드 부여를 구조적으로 막는다. 원문에 없는 원인을 추정하면
 *     스팬을 댈 수 없으므로 모델이 스스로 걸린다.
 *
 *  3) 신뢰도를 두 갈래로 잰다 (§5.2.3)
 *     confidence_score  LLM 자기보고 — 틀린 답에도 0.9 를 주는 경우가 흔하다
 *     agreement_score   같은 입력 반복 호출의 일치율 — 검수 정렬의 주 지표
 *     두 값이 엇갈리는 구간(자신 있다는데 답이 흔들림)이 가장 위험하다(§10 11번).
 */

import { structuredCall, type ReasoningEffort } from './client';
import { openaiConfig, tuning } from '../env';

// ---------------------------------------------------------------------------
// 코드북 스냅샷 — 프롬프트의 enum 재료
// ---------------------------------------------------------------------------

export interface CodeOption {
  code: string;
  name_ko: string;
  definition: string | null;
  /** 부록 G 키워드. 코드마다 몇 개만 보여도 판단이 크게 좋아진다 */
  keywords?: string[];
}

export interface CodebookSnapshot {
  version: string;
  hf: CodeOption[];
  dt: CodeOption[];
}

/** 코드 목록을 프롬프트에 넣을 형태로 편다 */
function renderCodeList(options: CodeOption[]): string {
  return options
    .map((o) => {
      const kw = o.keywords?.length ? ` [연관어: ${o.keywords.slice(0, 6).join(', ')}]` : '';
      const def = o.definition ? ` — ${o.definition}` : '';
      return `${o.code} (${o.name_ko})${def}${kw}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// 출력 스키마 (§5.2.1 의 산출 항목)
// ---------------------------------------------------------------------------

export interface TaggingOutput {
  hf_primary: string;
  hf_secondary: string[];
  dt_primary: string;
  dt_secondary: string[];
  keywords: string[];
  chunk_summary: string;
  confidence_score: number;
  evidence_span: string;
  /** 사건 코드화에만 있다 — 사고경위 원문 인용 */
  incident_summary?: string;
  /** 사건 코드화에만 있다 — 원인 서술 원문 인용. 없으면 빈 문자열 */
  stated_cause?: string;
}

/**
 * @param withIncidentFields 사건 코드화용 필드를 넣는다.
 *
 * 왜 사건에만 넣는가 (실측으로 확인한 문제)
 *   사고조사보고서는 표·목차·시험절차가 뒤섞인 1만 자 넘는 문서다. 그 안에
 *   "가열식 가습기의 물 부족시 자동 전원 차단 기능 미작동으로 화재 발생" 같은
 *   한 줄이 묻혀 있는데, 코드만 물었더니 5건 모두 HF.UNKNOWN 이 나왔다.
 *   원인이 없어서가 아니라 못 찾은 것이다.
 *
 *   그래서 코드를 고르기 전에 사고경위와 원인 서술을 **먼저 인용하게** 만든다.
 *   인용을 required 로 두면 모델이 그 구절을 찾아 읽어야만 스키마를 채울 수 있다.
 *   부수적으로 설계문서 §8.1 이 화면에 보이라고 한 "자동 추출된 항목과 근거 위치"가
 *   그대로 생긴다.
 */
function buildSchema(
  snapshot: CodebookSnapshot,
  withIncidentFields = false,
): Record<string, unknown> {
  const hfCodes = snapshot.hf.map((o) => o.code);
  const dtCodes = snapshot.dt.map((o) => o.code);

  const incidentProps = withIncidentFields
    ? {
        incident_summary: {
          type: 'string',
          description:
            '사고경위를 원문에서 그대로 인용한다. "사고경위", "사고 개요", "결함조사" 같은 ' +
            '항목 뒤의 서술을 찾는다. 목차나 조사 절차 설명이 아니라 실제로 무슨 일이 ' +
            '있었는지를 적은 문장이어야 한다.',
        },
        stated_cause: {
          type: 'string',
          description:
            '원인이 서술돼 있으면 그 구절을 원문에서 그대로 인용한다. ' +
            '"…미작동으로 화재 발생", "…결함으로 인한" 같은 서술이 해당한다. ' +
            '시험 결과 결함이 확인되지 않았거나 원인 서술이 없으면 빈 문자열로 둔다.',
        },
      }
    : {};

  return {
    type: 'object',
    additionalProperties: false,
    // 전부 required — 요약만 쓰고 근거를 빠뜨리는 일을 구조로 막는다(§5.2.2)
    required: [
      ...(withIncidentFields ? ['incident_summary', 'stated_cause'] : []),
      'hf_primary', 'hf_secondary', 'dt_primary', 'dt_secondary',
      'keywords', 'chunk_summary', 'confidence_score', 'evidence_span',
    ],
    properties: {
      ...incidentProps,
      // 주된 위해요인 1개 필수 (PDR §4.3)
      hf_primary: { type: 'string', enum: hfCodes },
      hf_secondary: { type: 'array', items: { type: 'string', enum: hfCodes } },
      dt_primary: { type: 'string', enum: dtCodes },
      dt_secondary: { type: 'array', items: { type: 'string', enum: dtCodes } },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description:
          '핵심 용어 + 동의어·구어 표현 + 수치·단위. ' +
          '사고보고서는 "넘어졌다", 기준은 "전도"로 쓰므로 둘을 이어 줄 표현을 반드시 포함한다.',
      },
      chunk_summary: {
        type: 'string',
        description: '이 대상이 무엇을 막으려는 규정인지(또는 무슨 사고인지) 한 문장.',
      },
      confidence_score: { type: 'number', description: '0.0~1.0 자기보고 확신도' },
      evidence_span: {
        type: 'string',
        description: '코드를 붙인 근거가 된 원문 구절을 그대로 인용. 원문에 없으면 빈 문자열.',
      },
    },
  };
}

/**
 * M-SHELL 대분류 우선순위 — 주된 위해요인(hf_primary) 선정 규칙
 *
 * 근거: 본 PDR §4.4, Recall Hub PHICS 전략 §2.3 (같은 규칙을 두 문서가 각자
 * 명시). 복수의 M-SHELL 요인이 동시에 성립할 때(예: 하드웨어 결함이면서
 * 동시에 설계 검토 부실) 어느 쪽을 주된 코드로 낼지가 프롬프트에 없으면,
 * 같은 조항·같은 사건을 다시 태깅했을 때 이번엔 H, 다음엔 M 이 나올 수 있다.
 * 이 시스템의 재현성 원칙(§1.1 원칙 2 "같은 입력에 항상 같은 출력")이
 * hf_primary 선택 하나에서 조용히 깨지는 지점이라 명시적으로 박아 둔다.
 */
const MSHELL_PRIORITY = `hf_primary 선정 우선순위 (복수 요인이 동시에 성립할 때 적용)
1순위 HF.H(하드웨어 결함) — 물리적 제품 결함이 직접 원인인 경우
2순위 HF.S(절차·기준 위반) — 기준 미준수·공정 절차 위반이 주된 원인인 경우
3순위 HF.M(관리 결함) — 설계·품질관리 체계 결함이 주된 원인인 경우
4순위 HF.E(환경 요인) — 사용·보관 환경이 직접 원인이고 제품 결함이 없는 경우
5순위 HF.L0/L1(사용자/관련자) — 반드시 HF.M.DES 또는 HF.M.QMS 를 hf_secondary 로 병기
마지막 HF.UNKNOWN — 원인이 서술돼 있지 않을 때만`;

const SYSTEM_CLAUSE = `당신은 KC안전기준 조항에 2차원 위해요인 분류 코드를 붙이는 분류기다.

규칙
- 코드는 제시된 목록에서만 고른다. 목록에 없는 코드는 어떤 경우에도 만들지 않는다.
- evidence_span 은 반드시 원문에서 그대로 인용한다. 근거를 댈 수 없으면 빈 문자열로 두고
  confidence_score 를 낮춘다. 추정으로 코드를 붙이지 않는다.
- 조항은 "무엇을 막으려는 규정인가"를 기준으로 판단한다. 안정성 요건이면 원인은 설계·구조,
  결과는 낙상·전도 쪽이다.
- 조항이 시험절차·측정방법·합격판정값만 서술하고 위해요인 자체를 언급하지 않으면
  (예: "시험 전압을 인가한 후 5초 이내에 측정한다", "표 3에서 정한 값을 초과하여서는
  안 된다") hf_primary 를 HF.UNKNOWN 으로 둔다. 목록에서 마땅한 코드가 안 보인다고
  HF.S(절차·기준 위반)를 대신 고르지 않는다 — HF.S 는 회사가 국내표준을 지키지
  않았다거나(HF.S.NATL) 내부규정이 없다는(HF.S.CORP) 것을 조항이 실제로 서술할
  때만 쓴다.
- chunk_summary 는 담당자가 조항 원문을 펼치지 않고도 판단할 수 있는 한 문장으로 쓴다.
- keywords 에는 기준 문체의 용어(전도, 용출)와 일상 표현(넘어짐, 녹아나옴)을 함께 넣는다.

${MSHELL_PRIORITY}`;

const SYSTEM_CASE = `당신은 제품 사고·리콜 서술문에 2차원 위해요인 분류 코드를 붙이는 분류기다.

규칙
- 코드는 제시된 목록에서만 고른다. 목록에 없는 코드는 어떤 경우에도 만들지 않는다.
- evidence_span 은 반드시 원문에서 그대로 인용한다. 원문에 없는 원인을 추정하지 않는다.
  원인이 서술되어 있지 않으면 HF 는 미확인 코드를 쓰고 confidence_score 를 낮춘다.
- 원인(HF)과 결과(DT)를 구분한다. "화재가 났다"는 결과이고, 원인은 배터리·과열 같은 것이다.
- 사용자 오용 코드(HF.L0/L1)는 단독으로 쓰지 않는다. 쓸 경우 설계·품질관리 코드를 함께 낸다.

순서를 지킨다
- 코드를 고르기 전에 incident_summary 와 stated_cause 를 먼저 채운다.
  사고조사보고서는 표·목차·시험절차가 뒤섞여 있어 실제 사고 서술이 묻히기 쉽다.
  "사고경위", "사고 개요", "결함조사", "사고원인" 항목 뒤의 문장을 찾아 인용한다.
- 그 인용에 근거해 코드를 정한다. stated_cause 가 비어 있을 때만 HF.UNKNOWN 을 쓴다.
  원인이 적혀 있는데 UNKNOWN 을 쓰면 안 된다.
- 시험 결과 결함이 확인되지 않았다면(예: "발화 및 폭발이 발생되지 않음")
  stated_cause 를 비우고 HF.UNKNOWN 을 쓰는 것이 맞다.

${MSHELL_PRIORITY}`;

// ---------------------------------------------------------------------------
// 태깅 실행
// ---------------------------------------------------------------------------

export interface TagResult {
  /** 최종 확정된 출력. 승격됐으면 상위 모델의 답, 아니면 1차 다수결 */
  output: TaggingOutput;
  /** 1차 반복 호출의 일치도 (§5.2.3). 승격 여부와 무관하게 1차 값을 남긴다 */
  agreementScore: number;
  /** 총 호출 횟수 (1차 반복 + 승격 1회) */
  callCount: number;
  /** 모든 호출의 원응답. 실행 매니페스트에 남긴다 */
  attempts: TaggingOutput[];
  /** 최종 답을 낸 모델. clause_tag.tagging_model 에 저장한다 */
  model: string;
  /** 상위 모델로 승격됐는가 */
  escalated: boolean;
  /**
   * 승격한 상위 모델이 1차 다수결과 다른 답을 냈는가.
   *
   * §5.2.3 이 "가장 위험한 구간"이라 부른 자리다. 싼 모델이 흔들렸고 비싼 모델도
   * 다른 답을 냈다면, 그 조항은 코드 체계로 깔끔히 표현되지 않는다는 뜻일 수 있다.
   * 검수 대기열의 맨 앞에 놓아야 하고, 반복되면 코드 체계 개선 신호로 본다.
   */
  escalationDisagreed: boolean;
  /** 누적 토큰 — 비용 실측용 */
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number };
}

/** 코드 집합의 일치도 — 반복 호출이 같은 답을 냈는가 */
function agreementOf(attempts: TaggingOutput[]): number {
  if (attempts.length <= 1) return 1;
  const keyOf = (a: TaggingOutput) => `${a.hf_primary}|${a.dt_primary}`;
  const counts = new Map<string, number>();
  for (const a of attempts) counts.set(keyOf(a), (counts.get(keyOf(a)) ?? 0) + 1);
  return Math.max(...counts.values()) / attempts.length;
}

/** 다수결. 동률이면 자기보고 확신도가 높은 쪽 */
function majority(attempts: TaggingOutput[]): TaggingOutput {
  const keyOf = (a: TaggingOutput) => `${a.hf_primary}|${a.dt_primary}`;
  const counts = new Map<string, number>();
  for (const a of attempts) counts.set(keyOf(a), (counts.get(keyOf(a)) ?? 0) + 1);
  const best = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
  return attempts
    .filter((a) => keyOf(a) === best)
    .sort((a, b) => b.confidence_score - a.confidence_score)[0];
}

/**
 * 2단 태깅 — 싼 모델을 여러 번, 흔들린 것만 비싼 모델로
 *
 * v0.6 §4.3 은 3~5회 반복을, v0.7 §0.4 는 "비용이 크다"며 축소를 지시했다.
 * 둘 다 "반복 = 비싸다"를 전제하는데, 실측하니 그 전제가 지금 모델 가격에서는
 * 성립하지 않는다.
 *
 *   프롬프트 2,500토큰 실측 기준 (조항 1건당)
 *     Luna  3회  $0.00222
 *     Terra 1회  $0.00740      ← 싼 모델 세 번이 비싼 모델 한 번보다 3.3배 싸다
 *
 * 그래서 반복을 줄이는 대신 **반복을 싼 모델로 옮긴다**. 이렇게 하면
 * §5.2.3 이 "검수 정렬의 주 지표"라 한 반복 일치도를 포기하지 않아도 된다.
 *
 * 왜 자기보고 확신도로 승격하지 않는가
 *   §5.2.3 이 명시한다 — "LLM 이 스스로 매긴 확신도는 실제 정확도와 어긋나는
 *   경향이 있다. 틀린 답에도 0.9 를 주는 경우가 흔하다."
 *   1차를 1회만 부르면 쓸 수 있는 신호가 그 못 믿을 자기보고뿐이다.
 *   3회 부르면 일치도라는 믿을 만한 신호가 생기고, 그게 승격 기준이 된다.
 */
async function runTagging(
  system: string,
  user: string,
  snapshot: CodebookSnapshot,
  withIncidentFields = false,
): Promise<TagResult> {
  const schema = buildSchema(snapshot, withIncidentFields);
  const cfg = openaiConfig();
  const t = tuning();

  const attempts: TaggingOutput[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };

  const call = async (model: string, effort: string) => {
    const r = await structuredCall<TaggingOutput>({
      model,
      system,
      user,
      schemaName: 'hazard_tagging',
      schema,
      effort: effort as ReasoningEffort,
    });
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.reasoningTokens += r.usage.reasoningTokens;
    return r.value;
  };

  // 1차 — 싼 모델을 반복해 일치도를 얻는다.
  // temperature 를 못 쓰지만 GPT-5.6 은 기본이 비결정적이라 반복만으로 흔들린다.
  for (let i = 0; i < Math.max(1, t.bulkRepeat); i++) {
    attempts.push(await call(cfg.bulkModel, cfg.bulkEffort));
  }

  const bulkAgreement = agreementOf(attempts);
  const bulkMajority = majority(attempts);

  // 2차 — 답이 흔들린 건만 상위 모델에 다시 묻는다
  if (bulkAgreement >= t.escalateBelowAgreement) {
    return {
      output: bulkMajority,
      agreementScore: bulkAgreement,
      callCount: attempts.length,
      attempts,
      model: cfg.bulkModel,
      escalated: false,
      escalationDisagreed: false,
      usage,
    };
  }

  const escalated = await call(cfg.escalateModel, cfg.escalateEffort);
  attempts.push(escalated);

  const sameAsBulk =
    escalated.hf_primary === bulkMajority.hf_primary &&
    escalated.dt_primary === bulkMajority.dt_primary;

  return {
    // 상위 모델의 답을 채택한다. 1차가 흔들렸다는 것 자체가 1차를 못 믿을 이유다.
    output: escalated,
    // 저장하는 일치도는 1차 값이다 — 이 조항이 얼마나 애매한지를 나타내는 수치이고,
    // 승격했다고 해서 애매함이 사라지는 것은 아니다.
    agreementScore: bulkAgreement,
    callCount: attempts.length,
    attempts,
    model: cfg.escalateModel,
    escalated: true,
    escalationDisagreed: !sameAsBulk,
    usage,
  };
}

/** L1 — 안전기준 조항 태깅 */
export function tagClause(
  clause: { contextHeader: string; marker: string; body: string; testConditions?: string[] },
  snapshot: CodebookSnapshot,
): Promise<TagResult> {
  const user = [
    '[위해요인(HF) 코드 목록]',
    renderCodeList(snapshot.hf),
    '',
    '[피해유형(DT) 코드 목록]',
    renderCodeList(snapshot.dt),
    '',
    '[대상 조항]',
    clause.contextHeader,
    `조항번호: ${clause.marker}`,
    `본문: ${clause.body}`,
    clause.testConditions?.length ? `시험조건: ${clause.testConditions.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return runTagging(SYSTEM_CLAUSE, user, snapshot);
}

/** L2 — 사고·국내리콜 코드화 */
export function tagCase(
  event: { itemName: string | null; title: string | null; narrative: string },
  snapshot: CodebookSnapshot,
): Promise<TagResult> {
  const user = [
    '[위해요인(HF) 코드 목록]',
    renderCodeList(snapshot.hf),
    '',
    '[피해유형(DT) 코드 목록]',
    renderCodeList(snapshot.dt),
    '',
    '[대상 사건]',
    event.itemName ? `품목: ${event.itemName}` : '',
    event.title ? `제목: ${event.title}` : '',
    `서술: ${event.narrative}`,
  ]
    .filter(Boolean)
    .join('\n');

  return runTagging(SYSTEM_CASE, user, snapshot, true);
}

/** 태깅 결과를 clause_tag / case_tag 행 모양으로 편다 (축별 행 — v0.7 §5.2) */
export function toTagRows(r: TagResult): Array<{
  axis: 'HF' | 'DT';
  code: string;
  is_primary: boolean;
  confidence_score: number;
  agreement_score: number;
  evidence_span: string;
}> {
  const o = r.output;
  const common = {
    confidence_score: o.confidence_score,
    agreement_score: r.agreementScore,
    evidence_span: o.evidence_span,
  };
  const rows = [
    { axis: 'HF' as const, code: o.hf_primary, is_primary: true, ...common },
    { axis: 'DT' as const, code: o.dt_primary, is_primary: true, ...common },
  ];
  for (const c of o.hf_secondary) {
    if (c !== o.hf_primary) rows.push({ axis: 'HF', code: c, is_primary: false, ...common });
  }
  for (const c of o.dt_secondary) {
    if (c !== o.dt_primary) rows.push({ axis: 'DT', code: c, is_primary: false, ...common });
  }
  return rows;
}
