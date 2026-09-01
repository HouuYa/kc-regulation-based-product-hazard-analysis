/**
 * 사건 1건을 분석해 시험 후보군을 뽑는다
 *
 *   npm run search -- --case 1
 *   npm run search -- --case 1 --no-rerank
 *   npm run search -- --case 1 --only code,keyword     갈래 선택 (§5.8 비교용)
 *   npm run search -- --text "의자가 옆으로 넘어졌다" --item "유아용 의자"
 *
 * 화면 D 가 보여 줄 것을 그대로 콘솔에 찍는다.
 * "판정하지 않는다"의 원칙(§8.4)에 따라 위반 여부를 말하지 않고
 * 관련 가능성과 근거만 제시한다.
 */

import { getDb, closeDb } from '../src/lib/db.js';
import {
  searchCandidates, diagnoseEmpty, persistRun,
  type MatchConfig, type MatchInput, type Candidate,
} from '../src/lib/search/match.js';
import { rerankCandidates } from '../src/lib/llm/rerank.js';
import { openaiConfig, tuning } from '../src/lib/env.js';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** 상위 몇 건을 기본 표시할 것인가. 나머지는 감추지 않고 접어 둔다(결정항목 17) */
const SHORTLIST = 5;

async function loadCase(caseId: number): Promise<MatchInput> {
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

  // 품목으로 적용 기준을 좁힌다 (v0.7 §3.2 — 범위를 먼저 확정한 뒤 검색)
  const standards = ev.item_name
    ? await db<{ id: number }[]>`
        select id from public.standard
        where is_current and item_name = ${ev.item_name}
      `
    : [];

  return {
    caseId: ev.id,
    itemName: ev.item_name,
    narrative: ev.narrative,
    hfCodes: tags.filter((t) => t.axis === 'HF').map((t) => t.code),
    dtCodes: tags.filter((t) => t.axis === 'DT').map((t) => t.code),
    keywords: ev.keywords ?? [],
    embedding: ev.embedding ? JSON.parse(ev.embedding) : null,
    standardIds: standards.length ? standards.map((s) => s.id) : null,
  };
}

function buildConfig(): MatchConfig {
  const t = tuning();
  const only = argValue('--only');
  const branches = only ? only.split(',').map((s) => s.trim()) : null;

  return {
    useCode:    branches ? branches.includes('code')    : true,
    useKeyword: branches ? branches.includes('keyword') : true,
    useVector:  branches ? branches.includes('vector')  : true,
    // 리랭킹은 0A·0B 의 필수 구성요소가 아니다 (v0.7 §7.6)
    useRerank:  !process.argv.includes('--no-rerank'),
    candidateCount: Number(argValue('--candidates') ?? '20'),
    rrfK: t.rrfK,
    wCode: t.weightCode,
    wCodePartial: t.weightCodePartial,
  };
}

function render(c: Candidate, rank: number) {
  const badge =
    c.matchPath === 'CODE'         ? '코드 일치' :
    c.matchPath === 'CODE-PARTIAL' ? '상위계위 일치' :
    c.matchPath === 'FALLBACK'     ? '폴백(미태깅)' :
                                     '코드 근거 없음';

  console.log(`\n[${rank}] ${c.marker}  ·  ${badge}  ·  증거수준 ${c.evidenceLevel}  ·  점수 ${c.score.toFixed(4)}`);
  console.log(`    ${c.standardName ?? ''} ${c.breadcrumbPath ?? ''}`);
  console.log(`    ${c.body.slice(0, 110)}`);
  if (c.rerankScore != null) {
    console.log(`    재채점 ${c.rerankScore.toFixed(2)} — ${c.rerankReason}`);
  }
  if (c.testConditions.length) {
    console.log(`    시험조건: ${c.testConditions.slice(0, 3).join(' / ')}`);
  }
  for (const tm of c.testMethods) {
    console.log(`    → 시험방법 ${tm.marker}${tm.body ? `: ${tm.body.slice(0, 70)}` : ' (다른 기준에 있음)'}`);
  }
}

async function main() {
  const caseId = Number(argValue('--case') ?? '0');
  if (!caseId) {
    throw new Error('분석할 사건을 지정하세요:  npm run search -- --case 1');
  }

  const config = buildConfig();
  const input = await loadCase(caseId);

  console.log(`사건 ${caseId}: ${input.narrative.slice(0, 70)}`);
  console.log(`품목      : ${input.itemName ?? '(미확정)'}`);
  console.log(`코드      : HF [${input.hfCodes.join(', ')}] / DT [${input.dtCodes.join(', ')}]`);
  console.log(`적용 기준 : ${input.standardIds?.length ?? 0}건`);
  console.log(`갈래      : 코드=${config.useCode} 키워드=${config.useKeyword} 의미=${config.useVector} 리랭킹=${config.useRerank}`);

  // v0.7 §3.2: 품목이 불명확하면 전 품목 검색을 자동 실행하지 않는다
  if (!input.standardIds?.length) {
    console.log('');
    console.log('SCOPE_UNRESOLVED — 품목에 대응하는 적용 기준을 찾지 못했습니다.');
    console.log('전 기준 검색을 자동으로 실행하지 않습니다. 다른 품목의 시험이 섞이기 때문입니다.');
    return;
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

  console.log('');
  if (candidates.length === 0) {
    const reason = await diagnoseEmpty(input);
    console.log(`후보 0건 — 사유: ${reason}`);
    console.log('검색 0건 자체를 기준 사각지대로 집계하지 않습니다(v0.7 §7.8).');
    console.log('전문가가 조항 부재 신호로 확인한 건만 정책 신호에 포함합니다.');
  } else {
    console.log(`관련될 수 있는 조항 ${candidates.length}건 — 확인을 권고합니다.`);
    candidates.slice(0, SHORTLIST).forEach((c, i) => render(c, i + 1));
    if (candidates.length > SHORTLIST) {
      console.log(`\n… 그 밖에 ${candidates.length - SHORTLIST}건이 더 있습니다 (감추지 않고 저장돼 있습니다).`);
    }
  }
  console.log('');
  console.log(`match_run = ${runId}. 채택·반려 기록이 §5.8 재현율·오탐률의 재료가 됩니다.`);
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
