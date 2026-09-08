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
import { groupBySection, flattenSections } from './group-section';
import { hydeQuery } from './hyde';
import { rerankCandidates } from '../llm/rerank';
import { checkReadiness, type NotReadyReason } from './readiness';
import { openaiConfig, tuning } from '../env';

/** 상위 몇 건을 기본 표시할 것인가. 나머지는 감추지 않고 접어 둔다(결정항목 17) */
export const SHORTLIST = 5;

/**
 * 절로 묶기 전에 훑는 후보 수.
 *
 * 200 과 600 을 재 봤다. 600 은 재현율이 23.8% → 20.8% 로 오히려 떨어졌다 —
 * 잡음이 늘어 절 순위가 흐려진다. 넓게 잡는 것 자체가 개선은 아니다.
 */
const SECTION_POOL = 200;

/**
 * 절 점수를 무엇으로 낼 것인가.
 *
 * 합·최대·상위3 을 재 봤다. 합은 조항 수가 많은 절이 그냥 이겨서 12.0% 로 나빠졌고,
 * 최대가 23.8% 로 가장 좋았다 — 가장 잘 맞는 조항 하나로 절을 대표시키면 크기 편향이
 * 없다.
 */
const SECTION_SCORING = 'max' as const;

export interface RunOutcome {
  /** 품목에 대응하는 기준을 못 찾아 실행하지 않았다 */
  scopeUnresolved: boolean;
  /**
   * 자료 상태가 갖춰지지 않아 실행하지 않았다 (readiness.ts)
   *
   * 비어 있으면 통과한 것이다. scopeUnresolved 와 나눠 두는 이유는 담당자가
   * 해야 할 일이 다르기 때문이다 — 이쪽은 자료를 갖추는 일이고,
   * 저쪽은 품목·기준을 정하는 일이다.
   */
  notReady: NotReadyReason[];
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
    // 기본은 끔 — 기존 동작 그대로다(030). 미검수 태그의 비중을 먼저 재고 정한다
    requireApprovedTags: false,
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

  /*
    자료가 갖춰졌는지 먼저 본다 (readiness.ts)

    원문을 아직 아무도 안 본 사고보고서, 원본이 사라진 건, 코드가 없는 건은
    분석해도 그 결과를 되짚을 수 없다. 결과가 안 나오는 것이 아니라 나온 결과의
    출처를 말할 수 없다는 것이 문제다 — 그것이 이 체계가 지키기로 한 선이다.
  */
  const readiness = await checkReadiness(caseId);
  if (!readiness.ready) {
    return {
      scopeUnresolved: false, notReady: readiness.reasons, causeUnresolved, input, config,
      candidates: [], emptyReason: null, runId: null,
    };
  }

  // v0.7 §3.2: 품목이 불명확하면 전 품목 검색을 자동 실행하지 않는다
  if (!input.standardIds?.length) {
    return {
      scopeUnresolved: true, notReady: [], causeUnresolved, input, config,
      candidates: [], emptyReason: null, runId: null,
    };
  }

  /*
    넓게 뽑아 절로 묶은 뒤 같은 칸 수로 좁힌다 (2026-09-05 실측으로 채택)

    조항 하나하나는 신호가 약해도 같은 절의 형제가 여럿 걸리면 그 절은 강한 신호다.
    15.1 이 50위, 15.1.1 이 80위, 15.2 가 120위면 개별로는 다 밀리지만 절 15 는
    세 번 걸린 셈이다. 진단에서 정답 조항의 49%가 바로 이렇게 밀려 있었다.

      ①+②+③ 하이브리드      재현율 16.2%  오탐 89.5%  상위5 14.5%
      + 절 묶음(최대)        재현율 23.8%  오탐 87.9%  상위5 14.6%
      + 절 묶음 + 리랭킹      재현율 23.8%  오탐 87.9%  상위5 32.8%

    재현율이 오르면서 오탐도 함께 줄었다. 원인 다리와 달리 기본 목록에 바로 반영하는
    이유가 이것이다 — 잘 찾던 것을 망가뜨리지 않고 더 찾는다.

    600 건까지 넓히면 오히려 20.8% 로 떨어졌다. 잡음이 늘어 절 순위가 흐려진다.
    넓게 잡는 것 자체가 개선이 아니라는 뜻이라 200 에서 멈춘다.

    LLM 비용은 늘지 않는다. 넓히는 것은 SQL 조회이고, 리랭킹은 좁힌 뒤에 부른다.
  */
  /*
    HyDE — 사고 서술로 "답에 해당할 법한 조항"을 지어내 의미 갈래의 질의로 쓴다
    (04-2 §4, 2026-09-06 실측으로 채택)

    사고 서술과 기준 조항은 문체가 아예 달라 겹치는 낱말이 거의 없다.
      사고   "가습기를 켜 두고 자는데 타는 냄새가 나서 보니 불이 붙어 있었다"
      조항   "이상운전 시 온도 상승은 표 9에서 정한 값을 초과하여서는 안 된다"

      + 절 묶음(최대)             재현율 23.8%  오탐 87.9%  상위5 14.6%
      + 절 묶음 + 리랭킹           재현율 23.8%  오탐 87.9%  상위5 33.5%
      + 절 묶음 + HyDE + 리랭킹    재현율 25.2%  오탐 86.3%  상위5 36.5%

    리랭킹과 함께 써야 값어치가 난다. HyDE 만 켜면 재현율이 되레 23.2% 로 내려가는데,
    리랭킹을 얹으면 25.2% 로 오른다 — HyDE 가 만든 후보가 리랭커에게 더 나은 재료가 된다.

    실패하면 원래 임베딩으로 간다. HyDE 는 의미 갈래를 다듬는 단계이지 후보를 만드는
    단계가 아니므로, 여기서 멈출 이유가 없다.
  */
  let searchInput = input;
  // 지어낸 문단을 들고 있다가 match_run 에 남긴다(051). hyde.ts 가 "되짚기 위해
  // 돌려줄 뿐이다"라고 적어 두었는데 여기서 버리고 있었다 — 그러면 담당자가
  // "왜 이 조항이 나왔지"를 되짚을 때 이 단계가 빈칸이 된다
  let hydeText: string | null = null;
  if (config.useRerank && input.embedding) {
    try {
      const h = await hydeQuery({ ...input, caseId });
      searchInput = { ...input, embedding: h.embedding };
      hydeText = h.text;
    } catch (e) {
      console.error(`가상 조항 생성 실패 (사건 ${caseId}) — 원래 임베딩으로 진행합니다:`, e);
    }
  }

  const wide = await searchCandidates(searchInput, { ...config, candidateCount: SECTION_POOL });
  let candidates = flattenSections(
    groupBySection(wide, SECTION_SCORING),
    config.candidateCount,
  );

  /*
    리랭킹의 결과를 세 갈래로 구분해 남긴다 (031)

    전에는 리랭커가 죽어도 rerank_score 가 전부 null 인 채로 저장됐다. 그런데
    그것은 "리랭커가 후보를 다 낮게 봤다"와 화면에서 구별되지 않는다. 담당자는
    낮은 점수를 판단의 근거로 읽으므로, 사실은 아무도 채점하지 않은 결과를
    "관련성이 낮다"로 오해할 수 있다.
  */
  let rerankStatus: 'skipped' | 'ok' | 'failed' = 'skipped';

  const cfg = config.useRerank ? openaiConfig() : null;
  if (config.useRerank && candidates.length > 1 && cfg) {
    try {
      const scores = await rerankCandidates(
        { itemName: input.itemName, narrative: input.narrative, hfCodes: input.hfCodes, dtCodes: input.dtCodes },
        candidates.map((c) => ({
          clauseId: c.clauseId, marker: c.marker,
          contextHeader: c.contextHeader, body: c.body, testConditions: c.testConditions,
        })),
        cfg.rerankModel,
        caseId,
      );
      const byId = new Map(scores.map((s) => [s.clause_id, s]));
      candidates = candidates
        .map((c) => {
          const s = byId.get(c.clauseId);
          return s ? { ...c, rerankScore: s.relevance, rerankReason: s.reason } : c;
        })
        // 리랭커는 순서만 바꾼다. 후보를 늘리지도 지우지도 않는다(§5.6.3)
        .sort((a, b) => (b.rerankScore ?? -1) - (a.rerankScore ?? -1) || b.score - a.score);
      rerankStatus = 'ok';
    } catch (e) {
      // 검색 결과까지 버리지는 않는다 — 리랭킹은 순서를 다듬는 단계이지
      // 후보를 만드는 단계가 아니다. 다만 채점이 없었다는 사실은 남긴다
      console.error(`재채점 실패 (사건 ${caseId}):`, e);
      rerankStatus = 'failed';
    }
  }

  const runId = await persistRun(input, config, candidates, {
    embeddingModel: input.embedding ? openaiConfig().embeddingModel : null,
    rerankModel: rerankStatus === 'ok' ? cfg?.rerankModel ?? null : null,
    shortlist: SHORTLIST,
    rerankStatus,
    // 리랭커 모델·프롬프트 묶음의 판번호. 태깅의 tagging_version 과 같은 구실이다
    promptVersion: cfg ? `RERANK-${cfg.rerankModel}-${cfg.rerankEffort}` : null,
    hydeText,
  });

  // 0건도 1급 산출물이다 — 왜 0건인지를 남긴다(2.3 결정 A, v0.7 §7.8)
  const emptyReason = candidates.length === 0 ? await diagnoseEmpty(input) : null;

  return {
    scopeUnresolved: false, notReady: [], causeUnresolved,
    input, config, candidates, emptyReason, runId,
  };
}
