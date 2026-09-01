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

import { structuredCall } from './client';
import { optionalNumber, tuning } from '../env';

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
}

function buildSchema(snapshot: CodebookSnapshot): Record<string, unknown> {
  const hfCodes = snapshot.hf.map((o) => o.code);
  const dtCodes = snapshot.dt.map((o) => o.code);

  return {
    type: 'object',
    additionalProperties: false,
    // 전부 required — 요약만 쓰고 근거를 빠뜨리는 일을 구조로 막는다(§5.2.2)
    required: [
      'hf_primary', 'hf_secondary', 'dt_primary', 'dt_secondary',
      'keywords', 'chunk_summary', 'confidence_score', 'evidence_span',
    ],
    properties: {
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

${MSHELL_PRIORITY}`;

// ---------------------------------------------------------------------------
// 태깅 실행
// ---------------------------------------------------------------------------

export interface TagResult {
  /** 다수결로 확정된 출력 */
  output: TaggingOutput;
  /** 같은 입력 반복 호출에서 같은 코드가 나온 비율 (§5.2.3) */
  agreementScore: number;
  /** 실제 호출 횟수 — 위험 기반 재호출이면 건마다 다르다 */
  callCount: number;
  /** 모든 호출의 원응답. 실행 매니페스트에 남긴다 */
  attempts: TaggingOutput[];
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
 * 반복 호출 정책
 *
 * v0.6 §4.3 은 조항 태깅에 3~5회 반복을 권했다.
 * v0.7 §0.4 는 "비용이 크고 반복 일치도가 정확도 보증은 아니다. 위험 기반 재호출이
 * 적절하다"며 축소를 지시했다.
 *
 * 그래서 기본은 1회로 두고, 자기보고 확신도가 임계값 아래일 때만 더 부른다.
 * 임계값을 1.0 으로 올리면 v0.6 처럼 전건 반복이 되므로 두 방식을 모두 실험할 수 있다.
 */
function repeatPolicy() {
  return {
    maxCalls: tuning().repeatCount,
    /** 이 값 미만이면 재호출한다. 1.0 이면 전건 반복(v0.6 방식) */
    recallBelow: optionalNumber('TAGGING_RECALL_BELOW_CONFIDENCE', 0.85),
  };
}

async function runTagging(
  system: string,
  user: string,
  snapshot: CodebookSnapshot,
  model: string,
): Promise<TagResult> {
  const schema = buildSchema(snapshot);
  const policy = repeatPolicy();
  const attempts: TaggingOutput[] = [];

  for (let i = 0; i < Math.max(1, policy.maxCalls); i++) {
    const out = await structuredCall<TaggingOutput>({
      model,
      system,
      user,
      schemaName: 'hazard_tagging',
      schema,
      // 1회차는 결정론적으로, 반복분은 흔들어야 일치도가 의미를 갖는다(§5.2.3)
      temperature: i === 0 ? 0 : 0.7,
    });
    attempts.push(out);

    // 첫 답이 충분히 확신하면 더 부르지 않는다 (v0.7 §0.4 위험 기반 재호출)
    if (i === 0 && out.confidence_score >= policy.recallBelow) break;
  }

  return {
    output: majority(attempts),
    agreementScore: agreementOf(attempts),
    callCount: attempts.length,
    attempts,
  };
}

/** L1 — 안전기준 조항 태깅 */
export function tagClause(
  clause: { contextHeader: string; marker: string; body: string; testConditions?: string[] },
  snapshot: CodebookSnapshot,
  model: string,
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

  return runTagging(SYSTEM_CLAUSE, user, snapshot, model);
}

/** L2 — 사고·국내리콜 코드화 */
export function tagCase(
  event: { itemName: string | null; title: string | null; narrative: string },
  snapshot: CodebookSnapshot,
  model: string,
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

  return runTagging(SYSTEM_CASE, user, snapshot, model);
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
