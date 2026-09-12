/**
 * 저장된 병행 점검 결과를 화면용으로 읽는다 (070)
 *
 * 사건마다 가장 최근 실행 하나만 본다. 실행은 덮어쓰지 않고 쌓이므로(match_run 과
 * 같은 철학) 이전 것도 남아 있지만, 화면은 지금 상태를 보여 주는 자리다.
 */

import { getDb } from '../db';

export interface InvestigationItemRow {
  itemType: string;
  label: string;
  verdict: string | null;
  valueNum: number | null;
  unit: string | null;
  evidenceSpan: string;
  spanVerified: boolean;
  /** LLM(원문) / REGEX / PHOTO. 화면이 "원문 인용" 문구를 PHOTO 에는 다르게 보인다 */
  extractSource: string;
}

export interface FindingRow {
  id: number;
  findingType: string;
  outputKind: string;
  rank: number | null;
  standardName: string | null;
  sectionMarker: string | null;
  part: string | null;
  sectionTitle: string | null;
  testMethodMarker: string | null;
  hfCode: string | null;
  causeRoute: string | null;
  refCaseId: number | null;
  refTitle: string | null;
  similarity: number | null;
  support: number | null;
  confidence: number | null;
  lift: number | null;
  sampleSize: number | null;
  rationale: string;
  needsExpertConfirm: boolean;
  /** 담당자가 이미 판정했는가 */
  decision: string | null;
}

export interface SecondOpinionView {
  runId: number;
  startedAt: string;
  standardCount: number;
  requirementClauseCount: number;
  requirementSectionCount: number;
  performedTestCount: number;
  mappedTestCount: number;
  unmappedTestCount: number;
  gapSectionCount: number;
  droppedSpanCount: number;
  extractModel: string | null;
  extractAgreement: number | null;
  scopeEvidence: string | null;
  items: InvestigationItemRow[];
  findings: FindingRow[];
}

export async function loadSecondOpinion(caseId: number): Promise<SecondOpinionView | null> {
  const db = getDb();

  const [run] = await db<{
    id: string; started_at: string; standard_count: number;
    requirement_clause_count: number; requirement_section_count: number;
    performed_test_count: number; mapped_test_count: number; unmapped_test_count: number;
    gap_section_count: number; dropped_span_count: number;
    extract_model: string | null; extract_agreement: string | null; scope_evidence: string | null;
  }[]>`
    select id, started_at::text, coalesce(array_length(standard_ids, 1), 0) as standard_count,
           requirement_clause_count, requirement_section_count,
           performed_test_count, mapped_test_count, unmapped_test_count,
           gap_section_count, dropped_span_count,
           extract_model, extract_agreement::text, scope_evidence
    from public.second_opinion_run
    where case_id = ${caseId}
    order by started_at desc
    limit 1
  `;
  if (!run) return null;
  const runId = Number(run.id);

  const items = await db<{
    item_type: string; label: string; verdict: string | null;
    value_num: string | null; unit: string | null;
    evidence_span: string; span_verified: boolean; extract_source: string;
  }[]>`
    select item_type, label, verdict, value_num::text, unit, evidence_span, span_verified, extract_source
    from public.case_investigation_item
    where run_id = ${runId}
    order by
      case item_type
        when 'TEST_PERFORMED' then 1 when 'IDENTITY_CHECK' then 2
        when 'CONCLUSION' then 3 when 'NON_TARGET' then 3
        when 'MEASUREMENT' then 4 else 5 end,
      id
  `;

  /*
    소견에 절 제목을 붙여 준다.

    저장할 때는 절 번호만 남긴다 — 제목은 기준 쪽 자료라 소견 표에 복사해 두면
    기준을 다시 적재했을 때 옛 제목이 소견에 남는다. 읽을 때 이어 붙이는 것이 맞다.
  */
  const findings = await db<{
    id: string; finding_type: string; output_kind: string; rank: number | null;
    standard_name: string | null; section_marker: string | null; part: string | null;
    section_title: string | null; test_method_marker: string | null;
    hf_code: string | null; cause_route: string | null;
    ref_case_id: string | null; ref_title: string | null;
    similarity: string | null; support: number | null; confidence: string | null;
    lift: string | null; sample_size: number | null;
    rationale: string; needs_expert_confirm: boolean; decision: string | null;
  }[]>`
    select
      f.id, f.finding_type, f.output_kind, f.rank,
      s.display_name as standard_name, f.section_marker, f.part,
      (select c.title_raw from public.clause c
        where c.standard_id = f.standard_id
          and c.marker = f.section_marker
          and coalesce(c.part, '') = coalesce(f.part, '')
        limit 1) as section_title,
      (select c.marker from public.clause c where c.id = f.test_method_clause_id) as test_method_marker,
      f.hf_code, f.cause_route,
      f.ref_case_id, r.title as ref_title,
      f.similarity::text, f.support, f.confidence::text, f.lift::text, f.sample_size,
      f.rationale, f.needs_expert_confirm,
      (select v.decision from public.second_opinion_review v
        where v.finding_id = f.id order by v.created_at desc limit 1) as decision
    from public.second_opinion_finding f
    left join public.standard   s on s.id = f.standard_id
    left join public.case_event r on r.id = f.ref_case_id
    where f.run_id = ${runId}
    order by f.rank
  `;

  return {
    runId,
    startedAt: run.started_at,
    standardCount: run.standard_count,
    requirementClauseCount: run.requirement_clause_count,
    requirementSectionCount: run.requirement_section_count,
    performedTestCount: run.performed_test_count,
    mappedTestCount: run.mapped_test_count,
    unmappedTestCount: run.unmapped_test_count,
    gapSectionCount: run.gap_section_count,
    droppedSpanCount: run.dropped_span_count,
    extractModel: run.extract_model,
    extractAgreement: run.extract_agreement == null ? null : Number(run.extract_agreement),
    scopeEvidence: run.scope_evidence,
    items: items.map((i) => ({
      itemType: i.item_type,
      label: i.label,
      verdict: i.verdict,
      valueNum: i.value_num == null ? null : Number(i.value_num),
      unit: i.unit,
      evidenceSpan: i.evidence_span,
      spanVerified: i.span_verified,
      extractSource: i.extract_source,
    })),
    findings: findings.map((f) => ({
      id: Number(f.id),
      findingType: f.finding_type,
      outputKind: f.output_kind,
      rank: f.rank,
      standardName: f.standard_name,
      sectionMarker: f.section_marker,
      part: f.part,
      sectionTitle: f.section_title,
      testMethodMarker: f.test_method_marker,
      hfCode: f.hf_code,
      causeRoute: f.cause_route,
      refCaseId: f.ref_case_id == null ? null : Number(f.ref_case_id),
      refTitle: f.ref_title,
      similarity: f.similarity == null ? null : Number(f.similarity),
      support: f.support,
      confidence: f.confidence == null ? null : Number(f.confidence),
      lift: f.lift == null ? null : Number(f.lift),
      sampleSize: f.sample_size,
      rationale: f.rationale,
      needsExpertConfirm: f.needs_expert_confirm,
      decision: f.decision,
    })),
  };
}
