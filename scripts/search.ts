/**
 * 사건 1건을 분석해 시험 후보군을 뽑는다
 *
 *   npm run search -- --case 1
 *   npm run search -- --case 1 --no-rerank
 *   npm run search -- --case 1 --only code,keyword     갈래 선택 (§5.8 비교용)
 *
 * 화면 D 가 보여 줄 것을 그대로 콘솔에 찍는다.
 * "판정하지 않는다"의 원칙(§8.4)에 따라 위반 여부를 말하지 않고
 * 관련 가능성과 근거만 제시한다.
 *
 * 실행 자체는 src/lib/search/run.ts 가 한다
 *   화면에도 「분석 실행」 버튼이 생기면서 같은 로직을 두 곳이 쓰게 됐다.
 *   여기서는 인자만 해석하고 결과를 그리기만 한다(CLAUDE.md §9).
 *   갈래 선택(--only)·재채점 끄기(--no-rerank)는 비교 실험용이라 명령줄에만 있다.
 */

import { closeDb } from '../src/lib/db';
import { runAnalysis, defaultMatchConfig, SHORTLIST } from '../src/lib/search/run';
import type { Candidate } from '../src/lib/search/match';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function render(c: Candidate, rank: number) {
  const badge =
    c.matchPath === 'CODE'         ? '코드 일치' :
    c.matchPath === 'CODE-PARTIAL' ? '상위계위 일치' :
    c.matchPath === 'FALLBACK'     ? '코드 없이 찾음' :
                                     '코드 근거 없음';

  console.log(`\n[${rank}] ${c.marker}  ·  ${badge}  ·  증거수준 ${c.evidenceLevel}  ·  점수 ${c.score.toFixed(4)}`);
  console.log(`    ${c.standardName ?? ''} ${c.breadcrumbPath ?? ''}`);
  console.log(`    ${c.body.slice(0, 110)}`);
  if (c.rerankScore != null) {
    console.log(`    재채점 ${c.rerankScore.toFixed(2)} — ${c.rerankReason}`);
  }
  if (c.testConditions.length) {
    console.log(`    시험 항목·허용치: ${c.testConditions.slice(0, 3).join(' / ')}`);
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

  const only = argValue('--only');
  const branches = only ? only.split(',').map((s) => s.trim()) : null;
  const config = defaultMatchConfig({
    useCode:    branches ? branches.includes('code')    : true,
    useKeyword: branches ? branches.includes('keyword') : true,
    useVector:  branches ? branches.includes('vector')  : true,
    useRerank:  !process.argv.includes('--no-rerank'),
    candidateCount: Number(argValue('--candidates') ?? '20'),
  });

  const out = await runAnalysis(caseId, config);
  const { input, candidates } = out;

  console.log(`사건 ${caseId}: ${input.narrative.slice(0, 70)}`);
  console.log(`품목      : ${input.itemName ?? '(미확정)'}`);
  console.log(`코드      : HF [${input.hfCodes.join(', ')}] / DT [${input.dtCodes.join(', ')}]`);
  console.log(`적용 기준 : ${input.standardIds?.length ?? 0}건`);
  console.log(`갈래      : 코드=${config.useCode} 키워드=${config.useKeyword} 의미=${config.useVector} 재채점=${config.useRerank}`);

  if (out.scopeUnresolved) {
    console.log('');
    console.log('SCOPE_UNRESOLVED — 품목에 대응하는 적용 기준을 찾지 못했습니다.');
    console.log('전 기준 검색을 자동으로 실행하지 않습니다. 다른 품목의 시험이 섞이기 때문입니다.');
    return;
  }

  console.log('');
  if (candidates.length === 0) {
    console.log(`후보 0건 — 사유: ${out.emptyReason}`);
    console.log('검색 0건 자체를 기준 사각지대로 집계하지 않습니다(v0.7 §7.8).');
    console.log('전문가가 조항 부재 신호로 확인한 건만 정책 신호에 포함합니다.');
  } else {
    if (out.causeUnresolved) {
      // v0.7 §7.3 — 결과(DT)만으로 특정 시험을 단정하지 않는다
      console.log('※ 이 사건은 원인(HF)이 확정되지 않았습니다.');
      console.log('  조사에서 결함이 확인되지 않았거나 원인 서술이 없는 경우입니다.');
      console.log('  아래 후보는 피해유형·어휘·의미만으로 넓게 건진 것이므로, 코드 근거가 없습니다.');
      console.log('  특정 시험을 단정하지 말고 담당자가 직접 검토해 주세요.');
      console.log('');
    }
    console.log(`관련될 수 있는 조항 ${candidates.length}건 — 확인을 권고합니다.`);
    candidates.slice(0, SHORTLIST).forEach((c, i) => render(c, i + 1));
    if (candidates.length > SHORTLIST) {
      console.log(`\n… 그 밖에 ${candidates.length - SHORTLIST}건이 더 있습니다 (감추지 않고 저장돼 있습니다).`);
    }
  }
  console.log('');
  console.log(`match_run = ${out.runId}. 채택·반려 기록이 §5.8 재현율·오탐률의 재료가 됩니다.`);
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
