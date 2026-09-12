/**
 * 병행 점검 한 번을 실행하고 저장한다 (070)
 *
 * 이 파일이 절대 하지 않는 일 — 코드 리뷰 체크리스트 항목이다
 *   · public.case_tag 에 쓰기        (선 1 — 추정이 조사 결과로 굳으면 안 된다)
 *   · public.match_run / match_result 에 쓰기 (선 2 — 기본 목록을 덮지 않는다)
 *
 * 저장은 한 트랜잭션이다. run 은 들어갔는데 findings 가 안 들어간 상태가 남으면
 * "공백 0건" 과 "아직 안 돌렸음" 을 구분할 수 없다.
 */

import { getDb } from '../db';
import { tuning } from '../env';
import { standardsForCase } from '../cases/resolve-scope';
import { sectionKinds } from './narrative';
import { extractInvestigation, PROMPT_VERSION, type InvestigationExtract } from './extract';
import {
  loadApplicableClauses, matchPerformedTests, computeTestGap,
  type TestMatch, type GapResult,
} from './coverage';
import { collectRecallEvidence, type RecallEvidence, type RecallMatchMode } from './recall-evidence';
import { deriveLegalSignals, type LegalSignal } from './legal';
import { deriveBlindspots, type Blindspot } from './blindspot';
import { loadPhotoEvidence, type PhotoEvidence } from './photo-evidence';

export interface SecondOpinionOptions {
  /** 저장하지 않고 결과만 돌려준다 */
  dry?: boolean;
  extractVariant?: string;
  recallMatch?: RecallMatchMode;
  gapLimit?: number;
}

export interface SecondOpinionOutcome {
  caseId: number;
  runId: number | null;
  /** 왜 못 돌렸는가. 돌았으면 null */
  skipped: string | null;
  extract: InvestigationExtract | null;
  matches: TestMatch[];
  gap: GapResult | null;
  recall: RecallEvidence | null;
  legal: LegalSignal[];
  blindspots: Blindspot[];
  photoEvidence: PhotoEvidence;
  standardIds: number[];
  agreement: number;
  droppedSpans: number;
  /** 버린 인용 — dry 실행에서 무엇이 걸렸는지 보기 위해 */
  droppedTexts: string[];
  model: string | null;
  escalated: boolean;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number };
}

interface FindingRow {
  finding_type: string;
  output_kind: string;
  rank: number;
  score: number | null;
  standard_id: number | null;
  clause_id: number | null;
  section_marker: string | null;
  part: string | null;
  test_method_clause_id: number | null;
  hf_code: string | null;
  dt_code: string | null;
  cause_route: string | null;
  ref_case_id: number | null;
  similarity: number | null;
  gpc_match_level: string | null;
  support: number | null;
  confidence: number | null;
  lift: number | null;
  sample_size: number | null;
  rationale: string;
  evidence_span: string | null;
  needs_expert_confirm: boolean;
}

export async function runSecondOpinion(
  caseId: number,
  opts: SecondOpinionOptions = {},
): Promise<SecondOpinionOutcome> {
  const db = getDb();
  const t = tuning();
  const recallMatch = (opts.recallMatch ?? t.secondOpinionRecallMatch) as RecallMatchMode;
  const gapLimit = opts.gapLimit ?? t.secondOpinionGapLimit;

  const empty = {
    caseId, runId: null, extract: null, matches: [], gap: null, recall: null,
    legal: [], blindspots: [],
    photoEvidence: { measurements: [], components: [], used: false, analyzedWithB: false },
    standardIds: [], agreement: 0, droppedSpans: 0, droppedTexts: [], model: null, escalated: false,
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  };

  const [ev] = await db<{
    id: string; item_name: string | null; title: string | null;
    narrative: string; source_type: string;
  }[]>`
    select id, item_name, title, narrative, source_type
    from public.case_event where id = ${caseId}
  `;
  if (!ev) return { ...empty, skipped: '사건을 찾을 수 없습니다' };
  if (ev.source_type !== 'ACCIDENT') {
    // 리콜은 원인이 이미 적혀 있는 자료다. 병행 점검의 대상이 아니라 근거 쪽이다
    return { ...empty, skipped: '사고보고서가 아닙니다 — 병행 점검은 ACCIDENT 만 대상입니다' };
  }
  if (!ev.narrative?.trim()) return { ...empty, skipped: '원문이 비어 있습니다' };

  // 분모. 못 내면 시험 범위 공백이 성립하지 않는다 — 그래도 리콜 근거는 낼 수 있으므로
  // 여기서 멈추지 않고 아래에서 갈래별로 판단한다
  const standardIds = await standardsForCase(caseId);

  const caseDtCodes = (
    await db<{ code: string }[]>`
      select code from public.case_tag
      where case_id = ${caseId} and axis = 'DT' and review_status <> 'rejected'
    `
  ).map((r) => r.code);

  // ③ 리콜 교차 근거 — 통계 다리가 원인 후보를 주고, 그 후보가 ①의 관련성 필터에 쓰인다.
  // 그래서 공백 계산보다 먼저 부른다
  const recall = await collectRecallEvidence(caseId, caseDtCodes, recallMatch, 8);

  const extracted = await extractInvestigation({
    id: caseId,
    itemName: ev.item_name,
    title: ev.title,
    narrative: ev.narrative,
  });

  const { requirement } = await loadApplicableClauses(standardIds);
  const matches = matchPerformedTests(
    extracted.value.tests_performed.map((x) => x.name),
    requirement,
  );

  const gap = await computeTestGap({
    requirement,
    matches,
    caseDtCodes,
    // 시험으로 확인할 수 있는 원인만 공백 판단에 쓴다 — 불법·기준공백은 시험항목이
    // 아니므로 여기서 섞이면 안 된다(CLAUDE.md §10). 그쪽은 여기 legal/blindspot 이 낸다
    estimatedHf: recall.statistical
      .filter((c) => c.route === 'TEST')
      .map((c) => ({ code: c.hfCode, lift: c.lift })),
    limit: gapLimit,
  });

  // 사진(variant B) 재료 — 라운드 72. 있으면 문턱값 판단·인증 신호에 보탠다.
  // 없으면(대부분의 사진이 아직 A거나, 사진 자체가 없으면) 조용히 빈 값이라
  // 기존 동작과 똑같다 — 새 재료가 없다고 아무것도 달라지면 안 된다.
  const photoEvidence = await loadPhotoEvidence(caseId);

  // ② 불법 신호 — 동일성확인(인증기관 유권해석)·표시 서술을 규칙으로 코드화한다.
  // LLM 을 다시 부르지 않는다 — extractInvestigation() 이 이미 뽑아 둔 재료로 충분하다
  const ex = extracted.value;
  const legal = deriveLegalSignals({
    identity:
      ex.identity_check.present && ex.identity_check.conclusion === '상이함'
        ? {
            differingParts: ex.identity_check.differing_parts.join(', '),
            statedImpact: ex.identity_check.stated_impact,
            evidenceSpan: ex.identity_check.evidence_span,
          }
        : null,
    markingNotes: ex.marking_notes.map((m) => ({ note: m.note, evidenceSpan: m.evidence_span })),
    photoComponents: photoEvidence.components,
  });

  // ④ 기준 사각지대 — (비대상) 표시, 그리고 "적합인데 실제 피해 발생".
  // 측정값은 원문 + 사진(variant B) 을 합쳐서 본다 — 원문에 수치가 없어도
  // 사진의 온도그래프·전력계 화면만으로 문턱값 공백이 드러날 수 있다.
  const blindspots = deriveBlindspots({
    conclusionVerdict: ex.conclusion.verdict,
    isNonTarget: ex.conclusion.is_non_target,
    conclusionEvidence: ex.conclusion.evidence_span || `결론: ${ex.conclusion.verdict}`,
    caseDtCodes,
    measurements: [
      ...ex.measurements.map((m) => ({ label: m.label, value: m.value, unit: m.unit })),
      ...photoEvidence.measurements.map((m) => ({ label: `[사진] ${m.label}`, value: m.value, unit: m.unit })),
    ],
  });

  const outcome: SecondOpinionOutcome = {
    caseId,
    runId: null,
    skipped: null,
    extract: extracted.value,
    matches,
    gap,
    recall,
    legal,
    blindspots,
    photoEvidence,
    standardIds,
    agreement: extracted.agreement,
    droppedSpans: extracted.droppedSpans,
    droppedTexts: extracted.droppedTexts,
    model: extracted.model,
    escalated: extracted.escalated,
    usage: extracted.usage,
  };

  if (opts.dry) return outcome;

  outcome.runId = await persist(outcome, {
    narrative: ev.narrative,
    extractVariant: opts.extractVariant ?? t.secondOpinionExtract,
    gapScope: t.secondOpinionGapScope,
    recallMatch,
  });
  return outcome;
}

/** 소견 행을 만든다. 갈래마다 output_kind 가 다른 것이 불량/불법 분리선이다 */
function buildFindings(o: SecondOpinionOutcome): FindingRow[] {
  const rows: FindingRow[] = [];
  let rank = 1;

  // ① 시험 범위 공백 → 시험항목
  for (const g of o.gap?.sections ?? []) {
    rows.push({
      finding_type: 'TEST_GAP',
      output_kind: 'TEST_ITEM',
      rank: rank++,
      score: g.hitClauses,
      standard_id: g.standardId,
      clause_id: null,
      section_marker: g.section,
      part: g.part,
      test_method_clause_id: g.testMethodClauseId,
      hf_code: null,
      dt_code: null,
      cause_route: 'TEST',
      ref_case_id: null,
      similarity: null,
      gpc_match_level: null,
      support: g.hitClauses,
      confidence: null,
      lift: g.lift,
      // 분모는 이 절의 요건 조항 수다. "58개 중 3개" 와 "9개 중 7개" 는 다른 말이다
      sample_size: g.clauseIds.length,
      rationale:
        `보고서가 시험하지 않은 절입니다 — ${g.standardName ?? '기준'}` +
        (g.part ? ` ${g.part}` : '') + ` 절 ${g.section}` +
        (g.title ? ` 「${g.title}」` : '') +
        ` · 요건 조항 ${g.clauseIds.length}개 중 ${g.hitClauses}개가 이 사건과 닿습니다` +
        ` (특이성 ${g.lift}). 근거: ${g.relatedBy.join(', ')}`,
      evidence_span: null,
      needs_expert_confirm: true,
    });
  }

  // ③-A 통계 다리 → 참고
  for (const c of o.recall?.statistical ?? []) {
    rows.push({
      finding_type: 'RECALL_EVIDENCE',
      output_kind: 'REFERENCE',
      rank: rank++,
      score: c.confidence,
      standard_id: null, clause_id: null, section_marker: null, part: null,
      test_method_clause_id: null,
      hf_code: c.hfCode,
      dt_code: null,
      cause_route: c.route,
      ref_case_id: null, similarity: null, gpc_match_level: null,
      support: c.support,
      confidence: c.confidence,
      lift: c.lift,
      // 분모를 반드시 함께 남긴다 — "59%" 만 보이면 "이 사건이 그럴 확률" 로 읽힌다
      sample_size: c.sampleSize,
      rationale:
        `해외 리콜에서 같은 피해유형 ${c.sampleSize}건 중 ${c.support}건` +
        `(${(c.confidence * 100).toFixed(0)}%)에 「${c.nameKo ?? c.hfCode}」 가 함께 나왔습니다` +
        ` (특이성 ${c.lift}). 확인 경로: ${c.route}`,
      evidence_span: null,
      needs_expert_confirm: true,
    });
  }

  // ③-B 닮은 리콜 사례 → 참고
  for (const s of o.recall?.similar ?? []) {
    const xw = s.crosswalk;
    rows.push({
      finding_type: 'RECALL_EVIDENCE',
      output_kind: 'REFERENCE',
      rank: rank++,
      score: s.similarity,
      standard_id: xw?.standardIds[0] ?? null,
      clause_id: null, section_marker: null, part: null, test_method_clause_id: null,
      hf_code: s.hfCodes[0] ?? null,
      dt_code: s.dtCodes[0] ?? null,
      cause_route: null,
      ref_case_id: s.caseId,
      similarity: s.similarity,
      gpc_match_level: s.gpcMatchLevel,
      support: null, confidence: null, lift: null, sample_size: null,
      rationale:
        `닮은 리콜: ${s.title ?? s.itemName ?? `사건 ${s.caseId}`}` +
        (s.recallCountry ? ` (${s.recallCountry})` : '') +
        ` — 유사도 ${s.similarity}, 품목분류 일치 ${s.gpcMatchLevel}` +
        (s.hfCodes.length ? ` · 그 리콜의 원인 ${s.hfCodes.join(', ')}` : '') +
        (xw ? ` · ${xw.note}` : ''),
      evidence_span: null,
      needs_expert_confirm: true,
    });
  }

  // ② 불법 신호 → 인증·표시 확인항목. 시험항목과 절대 안 섞이도록 output_kind 를 다르게 둔다
  for (const l of o.legal) {
    rows.push({
      finding_type: 'LEGAL_SIGNAL',
      output_kind: 'CERT_MARKING_CHECK',
      rank: rank++,
      score: null,
      standard_id: null, clause_id: null, section_marker: null, part: null,
      test_method_clause_id: null,
      hf_code: l.hfCode,
      dt_code: null,
      cause_route: l.route,
      ref_case_id: null, similarity: null, gpc_match_level: null,
      support: null, confidence: null, lift: null, sample_size: null,
      rationale: l.rationale,
      evidence_span: l.evidenceSpan,
      needs_expert_confirm: true,
    });
  }

  // ④ 기준 사각지대 → 정책 신호. 전문가 확인 전에는 정책 신호로 집계하지 않는다(v0.7 §7.8)
  for (const b of o.blindspots) {
    rows.push({
      finding_type: 'STANDARD_GAP',
      output_kind: 'POLICY_SIGNAL',
      rank: rank++,
      score: null,
      standard_id: null, clause_id: null, section_marker: null, part: null,
      test_method_clause_id: null,
      hf_code: null, dt_code: null, cause_route: null,
      ref_case_id: null, similarity: null, gpc_match_level: null,
      support: null, confidence: null, lift: null, sample_size: null,
      rationale: b.rationale,
      evidence_span: b.evidenceSpan,
      needs_expert_confirm: true,
    });
  }

  return rows;
}

/** 추출 결과를 case_investigation_item 행으로 편다 */
function buildItems(
  e: InvestigationExtract,
  verify: (s: string) => boolean,
): Array<{
  item_type: string; label: string; normalized: string | null; verdict: string | null;
  value_num: number | null; unit: string | null; evidence_span: string; span_verified: boolean;
}> {
  const rows = [];

  for (const t of e.tests_performed) {
    rows.push({
      item_type: 'TEST_PERFORMED',
      label: t.name,
      normalized: t.name,
      verdict: t.verdict,
      value_num: null, unit: null,
      evidence_span: t.evidence_span,
      span_verified: verify(t.evidence_span),
    });
  }

  if (e.identity_check.present) {
    rows.push({
      item_type: 'IDENTITY_CHECK',
      label: e.identity_check.differing_parts.join(', ') || '동일성 확인',
      normalized: null,
      verdict: e.identity_check.conclusion,
      value_num: null, unit: null,
      evidence_span: e.identity_check.evidence_span,
      span_verified: verify(e.identity_check.evidence_span),
    });
  }

  rows.push({
    item_type: e.conclusion.is_non_target ? 'NON_TARGET' : 'CONCLUSION',
    label: e.conclusion.states_cause ? '원인 서술 있음' : '원인 서술 없음',
    normalized: null,
    verdict: e.conclusion.verdict,
    value_num: null, unit: null,
    // 결론은 인용을 못 대도 버리지 않는다 — "결론이 없다"와 "인용을 못 댔다"는 다르다.
    // 대신 span_verified=false 로 화면이 등급을 낮춘다. not null 이라 빈 문자열을 못 쓰므로
    // 인용이 없으면 판정 문구를 넣어 둔다
    evidence_span: e.conclusion.evidence_span || `(인용 없음) 결론: ${e.conclusion.verdict}`,
    span_verified: verify(e.conclusion.evidence_span),
  });

  for (const m of e.measurements) {
    const n = Number(String(m.value).replace(/[^0-9.\-]/g, ''));
    rows.push({
      item_type: 'MEASUREMENT',
      label: m.label,
      normalized: null,
      verdict: null,
      value_num: Number.isFinite(n) ? n : null,
      unit: m.unit,
      evidence_span: m.evidence_span,
      span_verified: verify(m.evidence_span),
    });
  }

  for (const k of e.marking_notes) {
    rows.push({
      item_type: 'MARKING_NOTE',
      label: k.note,
      normalized: null, verdict: null, value_num: null, unit: null,
      evidence_span: k.evidence_span,
      span_verified: verify(k.evidence_span),
    });
  }

  return rows;
}

async function persist(
  o: SecondOpinionOutcome,
  ctx: { narrative: string; extractVariant: string; gapScope: string; recallMatch: string },
): Promise<number> {
  const db = getDb();
  const { verifySpan } = await import('./narrative');
  const verify = (s: string) => verifySpan(ctx.narrative, s);

  const items = o.extract ? buildItems(o.extract, verify) : [];
  const findings = buildFindings(o);
  const mapped = o.matches.filter((m) => m.mapped).length;

  return db.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      insert into public.second_opinion_run (
        case_id, finished_at, extract_variant, gap_scope, recall_match,
        standard_ids, scope_method, scope_evidence,
        requirement_clause_count, requirement_section_count,
        performed_test_count, mapped_test_count, unmapped_test_count,
        gap_section_count, dropped_span_count,
        extract_model, extract_agreement, prompt_version, notes,
        photo_evidence_used, vision_prompt_variant
      ) values (
        ${o.caseId}, now(), ${ctx.extractVariant}, ${ctx.gapScope}, ${ctx.recallMatch},
        ${o.standardIds}, ${sectionKinds(ctx.narrative).join(',')}, ${o.recall?.note ?? null},
        ${o.gap?.requirementClauseCount ?? 0}, ${o.gap?.requirementSectionCount ?? 0},
        ${o.matches.length}, ${mapped}, ${o.matches.length - mapped},
        ${o.gap?.sections.length ?? 0}, ${o.droppedSpans},
        ${o.model}, ${o.agreement}, ${PROMPT_VERSION}, ${o.extract?.extraction_note || null},
        ${o.photoEvidence.used}, ${o.photoEvidence.analyzedWithB ? 'B' : null}
      ) returning id
    `;
    const runId = Number(run.id);

    for (const it of items) {
      await tx`
        insert into public.case_investigation_item (
          run_id, case_id, item_type, label, normalized, verdict,
          value_num, unit, evidence_span, span_verified, extract_source
        ) values (
          ${runId}, ${o.caseId}, ${it.item_type}, ${it.label}, ${it.normalized}, ${it.verdict},
          ${it.value_num}, ${it.unit}, ${it.evidence_span}, ${it.span_verified}, 'LLM'
        )
      `;
    }

    /*
      사진(variant B) 측정값을 별도 출처로 남긴다 (라운드 72).

      evidence_span 은 narrative 인용이 아니라 "몇 쪽 사진에서 봤다"는 사실
      자체다 — 그래서 span_verified 는 언제나 false 다. false 가 "찾지 못한
      인용"이 아니라 "애초에 원문 인용이 아니다"라는 뜻이 되도록, 화면은
      extract_source 로 이 둘을 구분해서 보여 준다(SecondOpinion.tsx).
    */
    for (const m of o.photoEvidence.measurements) {
      const n = Number(String(m.value).replace(/[^0-9.\-]/g, ''));
      await tx`
        insert into public.case_investigation_item (
          run_id, case_id, item_type, label, normalized, verdict,
          value_num, unit, evidence_span, span_verified, extract_source
        ) values (
          ${runId}, ${o.caseId}, 'MEASUREMENT', ${m.label}, null, null,
          ${Number.isFinite(n) ? n : null}, ${m.unit},
          ${`${m.pageNumber}쪽 사진에서 관찰: ${m.label} ${m.value}${m.unit}`}, false, 'PHOTO'
        )
      `;
    }

    for (const f of findings) {
      await tx`
        insert into public.second_opinion_finding (
          run_id, case_id, finding_type, output_kind, rank, score,
          standard_id, clause_id, section_marker, part, test_method_clause_id,
          hf_code, dt_code, cause_route, ref_case_id, similarity, gpc_match_level,
          support, confidence, lift, sample_size,
          rationale, evidence_span, needs_expert_confirm
        ) values (
          ${runId}, ${o.caseId}, ${f.finding_type}, ${f.output_kind}, ${f.rank}, ${f.score},
          ${f.standard_id}, ${f.clause_id}, ${f.section_marker}, ${f.part}, ${f.test_method_clause_id},
          ${f.hf_code}, ${f.dt_code}, ${f.cause_route}, ${f.ref_case_id}, ${f.similarity}, ${f.gpc_match_level},
          ${f.support}, ${f.confidence}, ${f.lift}, ${f.sample_size},
          ${f.rationale}, ${f.evidence_span}, ${f.needs_expert_confirm}
        )
      `;
    }

    return runId;
  });
}
