/**
 * 트랙 B — 리콜제품 분석
 *
 *   npm run recalls:analyze -- --case 41
 *   npm run recalls:analyze -- --guid EU:10099536
 *
 * 컨셉 1.3 이 트랙 B 에만 있다고 한 네 질문에 답한다.
 *
 *   1 이 리콜 사유에 대응하는 국내 안전기준 조항이 있는가
 *   2 있다면 어떤 시험으로 확인할 수 있는가
 *   3 없다면 그 사실 자체가 무엇을 말하는가
 *   4 대응 조항은 그 나라와 우리나라 사이 차이가 있는가
 *
 * 1·2 는 트랙 A 와 같은 엔진을 쓴다("입구는 둘, 엔진은 하나").
 * 3 은 v0.7 §7.8 의 빈 결과 분류를 그대로 쓴다.
 * 4 는 여기서만 하는 일이다 — 공고에 적힌 위반 표준을 우리 기준과 대조한다.
 *
 * v0.6 코멘트가 지적한 대로, 트랙 B 를 트랙 A 와 같은 검색 화면으로 축소하지
 * 않는다. 국내 유통 동일성과 조치 검토는 시스템이 추정하지 않고 담당자 확인
 * 결과를 받아 적는다 — 제품안전기본법 13조 3항 보고의무가 걸린 판단이기 때문이다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { crosswalk } from '../src/lib/recall/crosswalk';
import { standardsForCase } from '../src/lib/cases/resolve-scope';
import {
  searchCandidates, diagnoseEmpty, persistRun, isCauseUnresolved,
  type MatchConfig, type MatchInput,
} from '../src/lib/search/match';
import { openaiConfig, tuning } from '../src/lib/env';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const SHORTLIST = 5;

interface RecallRow {
  case_id: number | null;
  source: string;
  guid: string;
  title: string | null;
  brand: string | null;
  model: string | null;
  hazard_type: string | null;
  hazard_summary: string | null;
  recall_country: string | null;
  published_on: string | null;
  detail_url: string | null;
  cited_standards: string[];
  domestic_check: string;
}

async function main() {
  const db = getDb();
  const guid = argValue('--guid');
  const caseId = argValue('--case') ? Number(argValue('--case')) : null;
  if (!guid && !caseId) {
    throw new Error('대상을 지정하세요:  --case 41  또는  --guid EU:10099536');
  }

  const [src, g] = guid ? guid.split(':') : [null, null];
  const [rc] = await db<RecallRow[]>`
    select case_id, source, guid, title, brand, model, hazard_type, hazard_summary,
           recall_country, published_on::text, detail_url, cited_standards, domestic_check
    from public.recall_cache
    where ${guid ? db`source = ${src} and guid = ${g}` : db`case_id = ${caseId}`}
    limit 1
  `;
  if (!rc) throw new Error('해당 리콜이 캐시에 없습니다. npm run recalls:fetch 를 먼저 실행하세요.');

  console.log('='.repeat(78));
  console.log(`${rc.title ?? '(제품명 없음)'}`);
  console.log(`${rc.source} ${rc.guid} · ${rc.recall_country ?? ''} · ${rc.published_on ?? ''}`);
  if (rc.brand || rc.model) console.log(`브랜드/모델 : ${[rc.brand, rc.model].filter(Boolean).join(' / ')}`);
  console.log(`리콜 사유   : ${rc.hazard_type ?? ''}`);
  if (rc.hazard_summary) console.log(`            ${rc.hazard_summary.slice(0, 160)}`);
  if (rc.detail_url) console.log(`원문        : ${rc.detail_url}`);
  console.log('='.repeat(78));

  // 질문 4 를 먼저 낸다. 상대국 근거가 있으면 1·2 의 해석이 달라지기 때문이다
  const cw = await crosswalk(rc.hazard_summary);
  console.log('');
  console.log('[4] 그 나라와 우리나라 기준 차이');
  console.log(`    ${cw.note}`);

  if (!rc.case_id) {
    console.log('');
    console.log('사건 행이 없어 조항 검색을 건너뜁니다.');
    return;
  }

  // 질문 1·2 — 트랙 A 와 같은 엔진
  const [ev] = await db<{
    id: number; item_name: string | null; narrative: string;
    keywords: string[]; embedding: string | null;
  }[]>`
    select id, item_name, narrative, keywords, embedding::text
    from public.case_event where id = ${rc.case_id}
  `;
  const tags = await db<{ axis: string; code: string }[]>`
    select axis, code from public.case_tag
    where case_id = ${rc.case_id} and review_status <> 'rejected'
  `;
  if (tags.length === 0) {
    console.log('');
    console.log('위해요인 코드가 아직 없습니다.  npm run recalls:code 를 먼저 실행하세요.');
    return;
  }

  // 공고가 표준을 명시했다면 그 기준을 우선 적용 범위로 삼는다.
  // 상대국이 지목한 문서보다 확실한 적용 근거는 없다.
  const byScope = await standardsForCase(rc.case_id);
  const standardIds = cw.standardIds.length ? cw.standardIds : byScope;
  const scopeSource = cw.standardIds.length ? '공고 명시 표준' : '품목 적용범위';

  const t = tuning();
  const config: MatchConfig = {
    useCode: true, useKeyword: true, useVector: true,
    useRerank: false,
    candidateCount: Number(argValue('--candidates') ?? '20'),
    rrfK: t.rrfK, wCode: t.weightCode, wCodePartial: t.weightCodePartial,
    // 기존 동작 그대로. 검수 확정 태그만 쓰는 구성과의 비교는 npm run eval 에서 한다(030)
    requireApprovedTags: false,
  };
  const input: MatchInput = {
    caseId: ev.id,
    itemName: ev.item_name,
    narrative: ev.narrative,
    hfCodes: tags.filter((x) => x.axis === 'HF').map((x) => x.code),
    dtCodes: tags.filter((x) => x.axis === 'DT').map((x) => x.code),
    keywords: ev.keywords ?? [],
    embedding: ev.embedding ? JSON.parse(ev.embedding) : null,
    standardIds: standardIds.length ? standardIds : null,
  };

  console.log('');
  console.log(`위해요인 코드 : HF [${input.hfCodes.join(', ')}] / DT [${input.dtCodes.join(', ')}]`);
  console.log(`적용 기준     : ${standardIds.length}건 (${scopeSource})`);

  console.log('');
  console.log('[1] 대응하는 국내 안전기준 조항');

  if (!standardIds.length) {
    console.log('    SCOPE_UNRESOLVED — 품목에 대응하는 기준을 찾지 못했습니다.');
    console.log('    [3] 이 단계의 0건은 기준 사각지대가 아닙니다. 품목 등록이 먼저입니다.');
    return;
  }

  const candidates = await searchCandidates(input, config);
  const runId = await persistRun(input, config, candidates, {
    embeddingModel: input.embedding ? openaiConfig().embeddingModel : null,
    rerankModel: null,
    shortlist: SHORTLIST,
    // 이 스크립트는 재채점을 켜지 않는다(useRerank: false) — 껐다는 사실을 남긴다(031)
    rerankStatus: 'skipped',
    promptVersion: null,
  });

  if (candidates.length === 0) {
    const reason = await diagnoseEmpty(input);
    console.log(`    후보 0건 — 사유 ${reason}`);
    console.log('');
    console.log('[3] 대응 조항이 없다는 사실의 의미');
    console.log(reason === 'NO_RELEVANT_CLAUSE'
      ? '    기준 사각지대 후보입니다. 다만 전문가가 조항 부재를 확인한 건만 정책 신호에 넣습니다(v0.7 §7.8).'
      : `    아직 사각지대라고 말할 수 없습니다 — ${reason} 는 우리 쪽 데이터 상태 문제입니다.`);
  } else {
    if (isCauseUnresolved(input.hfCodes)) {
      console.log('    ※ 원인(HF)이 확정되지 않아 코드 근거 없이 넓게 건진 결과입니다.');
    }
    console.log(`    ${candidates.length}건`);
    for (const [i, c] of candidates.slice(0, SHORTLIST).entries()) {
      console.log('');
      console.log(`    [${i + 1}] ${c.marker}  ·  증거수준 ${c.evidenceLevel}  ·  ${c.standardName ?? ''}`);
      console.log(`        ${c.body.slice(0, 100)}`);
    }
    console.log('');
    console.log('[2] 확인할 수 있는 시험항목');
    const methods = candidates.slice(0, SHORTLIST).flatMap((c) =>
      c.testMethods.map((m) => `${c.marker} → ${m.marker}${m.body ? `: ${m.body.slice(0, 60)}` : ''}`));
    if (methods.length) methods.forEach((m) => console.log(`    ${m}`));
    else console.log('    연결된 시험방법 조항이 없습니다. 요구사항 본문의 시험조건을 확인하세요.');
  }

  // 조치 검토 — 시스템이 판단하지 않는다
  console.log('');
  console.log('[안전조치 검토]');
  console.log(`    국내 유통 동일성 : ${
    rc.domestic_check === 'UNCHECKED' ? '미확인 — 담당자 확인이 필요합니다' :
    rc.domestic_check === 'DISTRIBUTED' ? '유통 확인됨' :
    rc.domestic_check === 'NOT_DISTRIBUTED' ? '유통되지 않음' : '확인 불가'}`);
  console.log('    동일 제품이 국내 유통된 것으로 확인되면 제품안전기본법 제13조 제3항의');
  console.log('    사업자 즉시 보고 의무 대상인지 검토 대상이 됩니다.');
  console.log('    이 체계는 유통 여부를 추정하지 않습니다. 통관·유통 자료로 확인해야 합니다.');
  console.log('');
  console.log(`match_run = ${runId}`);
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
