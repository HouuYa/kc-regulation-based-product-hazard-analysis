/**
 * 분석 1회 실행 — 명령줄과 화면이 함께 쓰는 진입점
 *
 * 왜 이 파일이 생겼나
 *   지금까지 분석을 돌리는 길은 `npm run search -- --case 4639` 하나뿐이었다.
 *   그래서 화면에는 "이 명령어를 터미널에서 치세요"라는 안내가 박혀 있었고,
 *   담당자가 코드를 다루지 않으면 분석 자체를 시작할 수 없었다.
 *
 *   화면에 실행 버튼을 붙이면서, 그 버튼이 스크립트의 로직을 복사하면 두 경로가
 *   서서히 어긋난다(CLAUDE.md §9). 그래서 사건을 읽어 검색·재채점·저장까지 하는
 *   부분을 여기로 옮기고, scripts/search.ts 는 이 함수를 부른 뒤 결과를 콘솔에
 *   그리기만 한다.
 *
 * 판정하지 않는다
 *   이 함수는 "관련될 수 있는 조항"과 그 근거를 만들 뿐 위반 여부를 말하지 않는다(§8.4).
 *   품목을 특정하지 못하면 아무것도 실행하지 않고 그 사실을 돌려준다 — 전 기준을
 *   뒤지면 다른 제품의 시험이 섞이기 때문이다(v0.7 §3.2).
 */

import { getDb } from '../db';
import { standardsForCase } from '../cases/resolve-scope';
import {
  searchCandidates, diagnoseEmpty, persistRun, isCauseUnresolved,
  type MatchConfig, type MatchInput, type Candidate, type EmptyReason,
} from './match';
import { rerankCandidates } from '../llm/rerank';
import { openaiConfig, tuning } from '../env';

/** 상위 몇 건을 기본 표시할 것인가. 나머지는 감추지 않고 접어 둔다(결정항목 17) */
export const SHORTLIST = 5;

export interface RunOutcome {
  /** 품목에 대응하는 기준을 못 찾아 실행하지 않았다 */
  scopeUnresolved: boolean;
  /** 원인(HF)이 확정되지 않은 사건 — 후보를 넓게 건진 것이므로 단정하면 안 된다(v0.7 §7.3) */
  causeUnresolved: boolean;
  input: MatchInput;
  config: MatchConfig;
  candidates: Candidate[];
  /** 후보가 0건일 때만 채워진다 */
  emptyReason: EmptyReason | null;
  /** 실행하지 않았으면 null */
  runId: number | null;
}

/** 사건 1건을 검색 입력으로 읽는다 */
export async function loadCaseInput(caseId: number): Promise<MatchInput> {
  const db = getDb();

  const [ev] = await db<{
    id: number; item_name: string | null; narrative: string;
    keywords: string[]; embedding: string | null;
  }[]>`
    select id, item_name, narrative, keywords, embedding::text
    from public.case_event where id = ${caseId}
  `;
  if (!ev) throw new Error(`사건 ${caseId} 이 없습니다.`);

  const tags = await db<{ axis: string; code: string }[]>`
    select axis, code from public.case_tag
    where case_id = ${caseId} and review_status <> 'rejected'
  `;

  // 품목으로 적용 기준을 좁힌다 (v0.7 §3.2 — 범위를 먼저 확정한 뒤 검색).
  // 등록된 품목이면 부속서+공통안전기준 세트를, 전기용품이면 적용범위 원문 검색 결과를 쓴다.
  const standardIds = await standardsForCase(caseId);

  return {
    caseId: ev.id,
    itemName: ev.item_name,
    narrative: ev.narrative,
    hfCodes: tags.filter((t) => t.axis === 'HF').map((t) => t.code),
    dtCodes: tags.filter((t) => t.axis === 'DT').map((t) => t.code),
    keywords: ev.keywords ?? [],
    embedding: ev.embedding ? JSON.parse(ev.embedding) : null,
    standardIds: standardIds.length ? standardIds : null,
  };
}

/**
 * 기본 설정. 화면은 이대로 쓰고, 명령줄만 갈래를 꺼 보며 비교한다(§5.8).
 */
export function defaultMatchConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  const t = tuning();
  return {
    useCode: true,
    useKeyword: true,
    useVector: true,
    // 리랭킹은 0A·0B 의 필수 구성요소가 아니다 (v0.7 §7.6)
    useRerank: true,
    candidateCount: 20,
    rrfK: t.rrfK,
    wCode: t.weightCode,
    wCodePartial: t.weightCodePartial,
    ...overrides,
  };
}

/**
 * 검색 → 재채점 → 저장.
 *
 * 재채점(리랭킹)을 켜면 LLM 을 1회 부른다. 후보 20건짜리 호출 한 번이라
 * 화면 버튼으로 눌러도 몇 초 안에 끝난다.
 */
export async function runAnalysis(
  caseId: number,
  config: MatchConfig = defaultMatchConfig(),
): Promise<RunOutcome> {
  const input = await loadCaseInput(caseId);
  const causeUnresolved = isCauseUnresolved(input.hfCodes);

  // v0.7 §3.2: 품목이 불명확하면 전 품목 검색을 자동 실행하지 않는다
  if (!input.standardIds?.length) {
    return {
      scopeUnresolved: true, causeUnresolved, input, config,
      candidates: [], emptyReason: null, runId: null,
    };
  }

  let candidates = await searchCandidates(input, config);

  const cfg = config.useRerank ? openaiConfig() : null;
  if (config.useRerank && candidates.length > 1 && cfg) {
    const scores = await rerankCandidates(
      { itemName: input.itemName, narrative: input.narrative, hfCodes: input.hfCodes, dtCodes: input.dtCodes },
      candidates.map((c) => ({
        clauseId: c.clauseId, marker: c.marker,
        contextHeader: c.contextHeader, body: c.body, testConditions: c.testConditions,
      })),
      cfg.rerankModel,
    );
    const byId = new Map(scores.map((s) => [s.clause_id, s]));
    candidates = candidates
      .map((c) => {
        const s = byId.get(c.clauseId);
        return s ? { ...c, rerankScore: s.relevance, rerankReason: s.reason } : c;
      })
      // 리랭커는 순서만 바꾼다. 후보를 늘리지도 지우지도 않는다(§5.6.3)
      .sort((a, b) => (b.rerankScore ?? -1) - (a.rerankScore ?? -1) || b.score - a.score);
  }

  const runId = await persistRun(input, config, candidates, {
    embeddingModel: input.embedding ? openaiConfig().embeddingModel : null,
    rerankModel: config.useRerank ? cfg?.rerankModel ?? null : null,
    shortlist: SHORTLIST,
  });

  // 0건도 1급 산출물이다 — 왜 0건인지를 남긴다(2.3 결정 A, v0.7 §7.8)
  const emptyReason = candidates.length === 0 ? await diagnoseEmpty(input) : null;

  return { scopeUnresolved: false, causeUnresolved, input, config, candidates, emptyReason, runId };
}
