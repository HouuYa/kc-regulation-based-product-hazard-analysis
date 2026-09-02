/**
 * 해외 리콜 적재 — 트랙 B 의 입구
 *
 *   npm run recalls:fetch                         승인된 전체
 *   npm run recalls:fetch -- --source EU --limit 50
 *   npm run recalls:fetch -- --stats               출처별 현황만
 *
 * 2026-09-02 부터 Recall Hub 의 얇은 REST API(hub.ts, 16개 필드) 대신 원본 표를
 * 직접 읽는다(src/lib/recall/source.ts). 담당자가 검토·승인(approval_status)까지
 * 마치고 위해요인(HF-DT)까지 분류해 둔 값을 그대로 쓴다 — 그래서 이 스크립트가
 * 한 번에 다 한다. 예전에는 recalls:fetch(캐시) 다음에 recalls:code(AI 태깅)를
 * 따로 돌려야 했는데, 이제 원본에 이미 코드가 있어 그 단계가 없어졌다.
 *
 *   1) recall_cache 에 원본을 통째로 보관한다(§7.1 원본층, raw_data 포함).
 *   2) case_event 에 source_type='RECALL_OVERSEAS' 로 승격한다.
 *   3) 품목을 확정한다(resolveProductScope) — tag-cases.ts 의 1단계와 같다.
 *   4) 관리자가 이미 붙인 HF-DT 코드로 case_tag 를 채운다. AI 호출 없음.
 *
 * 2026-09-02(2차) — 관리자 주코드가 우리 코드북에 없을 때(예: v0.9에서 이미 폐기된
 * HF.S.STD) 더는 "미분류"로 남기지 않는다. 그 축만 tagCase()로 다시 채운다.
 * tagCase() 는 코드북 스냅샷에서 뽑은 enum만 반환하므로 무효 코드가 나올 수
 * 자체가 없다 — 새 프롬프트를 안 만들어도 이 상황을 영구적으로 막아 준다.
 * 이렇게 채운 축은 case_tag.review_status='auto_unreviewed'로 표시해 담당자
 * 검수 대상임을 남긴다(원본 관리자값은 review_status='approved').
 */

import { getDb, closeDb } from '../src/lib/db';
import { fetchApprovedRecalls, fetchApprovedStats, type SourceRecall } from '../src/lib/recall/source';
import { crosswalk } from '../src/lib/recall/crosswalk';
import { loadCodebookSnapshot, codeLabelMap } from '../src/lib/codebook/snapshot';
import { buildCaseSearchText, type SearchTextVariant } from '../src/lib/search/search-text';
import { resolveProductScope } from '../src/lib/cases/resolve-scope';
import { tagCase } from '../src/lib/llm/tagging';
import { tuning } from '../src/lib/env';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** 검색·매칭이 읽을 서술문을 만든다. 원본 표가 주는 서술 필드를 최대한 붙인다 */
function narrativeOf(r: SourceRecall): string {
  return [
    r.product_name,
    r.product_name_original && r.product_name_original !== r.product_name
      ? `(${r.product_name_original})` : null,
    r.brand_name || null,
    r.model_name ? `모델 ${r.model_name}` : null,
    r.product_description,
    r.hazard_type,
    r.hazard_description,
    r.recall_cause,
  ].filter(Boolean).join(' · ');
}

/** 코드북에 있는 것만 남기고 순서를 지키며 중복을 뺀다 */
function dedupeValid(codes: (string | null | undefined)[], valid: Set<string>): string[] {
  const out: string[] = [];
  for (const c of codes) {
    if (c && valid.has(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

async function main() {
  const db = getDb();

  if (process.argv.includes('--stats')) {
    const stats = await fetchApprovedStats();
    const total = stats.reduce((s, r) => s + r.count, 0);
    console.log(`해외 리콜 승인 건 전체 ${total.toLocaleString()}건`);
    for (const s of stats) console.log(`  ${s.source.padEnd(16)}${String(s.count).padStart(5)}건`);
    await closeDb();
    return;
  }

  const source = argValue('--source') ?? undefined;
  const limit = argValue('--limit') ? Number(argValue('--limit')) : undefined;

  console.log(`원본 표 조회 : ${[source && `출처 ${source}`, limit && `최대 ${limit}건`].filter(Boolean).join(' · ') || '승인된 전체'}`);
  const rows = await fetchApprovedRecalls({ source, limit });
  console.log(`받은 건수     : ${rows.length}`);
  if (rows.length === 0) { await closeDb(); return; }

  const snapshot = await loadCodebookSnapshot({ includeUncommon: true });
  const labels = codeLabelMap(snapshot);
  const validHf = new Set(snapshot.hf.map((o) => o.code));
  const validDt = new Set(snapshot.dt.map((o) => o.code));
  const variant = tuning().searchTextVariant as SearchTextVariant;
  const taggingVersion = `ADMIN-recall_hub-${snapshot.version}`;

  let cached = 0, newCase = 0, existingCase = 0, resolved = 0, tagged = 0, withStd = 0;
  const unclassified: Array<{ cacheId: number; source: string; guid: string; hf: string | null; dt: string | null }> = [];
  const llmReclassified: Array<{ cacheId: number; source: string; guid: string; from: string; to: string }> = [];
  let droppedCodes = 0;

  for (const r of rows) {
    const cw = await crosswalk([r.hazard_description, r.recall_cause].filter(Boolean).join(' '));
    if (cw.standardIds.length) withStd++;

    // ── 원본층 — 표 전체를 raw 에 통째로 보관한다(§7.1). 파생 컬럼이 늘어도 다시
    //    받아 올 필요가 없다 ──────────────────────────────────────────────────
    const [cache] = await db<{ id: number }[]>`
      insert into public.recall_cache (
        source, guid, origin, title, brand, model, hazard_summary,
        hazard_type, recall_country, published_on, detail_url,
        cited_standards, matched_standard_ids,
        hazard_factor_code, hazard_factor_sub, damage_type_primary, damage_type_codes,
        iso5665_severity, approval_status, classification_confidence,
        injuries_count, has_confirmed_injuries, source_row_id,
        raw, fetched_at
      ) values (
        ${r.source}, ${r.guid}, 'OVERSEAS',
        ${r.product_name}, ${r.brand_name}, ${r.model_name}, ${r.hazard_description},
        ${r.hazard_type}, ${r.recall_country}, ${r.published_date}, ${r.source_url},
        ${cw.cited.map((c) => c.raw)}, ${cw.standardIds},
        ${r.hazard_factor_code}, ${r.hazard_factor_sub ?? []},
        ${r.damage_type_primary}, ${r.damage_type_codes ?? []},
        ${r.iso5665_severity}, ${r.approval_status}, ${r.classification_confidence},
        ${r.injuries_count}, ${r.has_confirmed_injuries}, ${r.id},
        ${db.json(r as never)}, now()
      )
      on conflict (source, guid) do update set
        title = excluded.title, hazard_summary = excluded.hazard_summary,
        hazard_type = excluded.hazard_type,
        cited_standards = excluded.cited_standards,
        matched_standard_ids = excluded.matched_standard_ids,
        hazard_factor_code = excluded.hazard_factor_code,
        hazard_factor_sub = excluded.hazard_factor_sub,
        damage_type_primary = excluded.damage_type_primary,
        damage_type_codes = excluded.damage_type_codes,
        iso5665_severity = excluded.iso5665_severity,
        approval_status = excluded.approval_status,
        classification_confidence = excluded.classification_confidence,
        injuries_count = excluded.injuries_count,
        has_confirmed_injuries = excluded.has_confirmed_injuries,
        raw = excluded.raw, fetched_at = now()
      returning id
    `;
    cached++;

    // ── 사건 행으로 승격 — 트랙 A 와 같은 엔진을 타기 위한 통로.
    //    external_ref 유니크 인덱스(014)로 재실행해도 중복이 안 생긴다 ──────────
    const externalRef = `${r.source}:${r.guid}`;
    let [ev] = await db<{ id: number }[]>`
      insert into public.case_event (
        source_type, external_ref, title, narrative, item_name, model_name,
        occurred_on, raw_fields, is_confirmed
      ) values (
        'RECALL_OVERSEAS', ${externalRef}, ${r.product_name},
        ${narrativeOf(r)}, ${r.product_name}, ${r.model_name},
        ${r.published_date}, ${db.json({ source: r.source, country: r.recall_country,
          hazard_type: r.hazard_type, source_url: r.source_url,
          cited_standards: cw.cited.map((c) => c.raw), crosswalk_note: cw.note } as never)},
        false
      )
      on conflict (source_type, external_ref) where external_ref is not null do nothing
      returning id
    `;
    if (ev) {
      newCase++;
    } else {
      existingCase++;
      [ev] = await db<{ id: number }[]>`
        select id from public.case_event
        where source_type = 'RECALL_OVERSEAS' and external_ref = ${externalRef}
      `;
    }
    if (!ev) continue; // 이론상 오지 않는다 — 방금 넣거나 방금 조회했다

    await db`update public.recall_cache set case_id = ${ev.id} where id = ${cache.id}`;

    // ── 품목 확정 (v0.7 §3.2, tag-cases.ts 1단계와 동일) ─────────────────────
    const scope = r.product_name ? await resolveProductScope(r.product_name) : null;
    if (scope) {
      resolved++;
      await db`
        update public.case_event
        set product_scope_id = ${scope.productScopeId}, scope_evidence = ${scope.evidence}
        where id = ${ev.id}
      `;
    }

    // ── 관리자 HF-DT 코드가 코드북에 있으면 그대로 쓴다. 없는 축만 tagCase()로
    //    다시 채운다(2단 반복+승격, AI 호출은 축이 무효일 때만) ─────────────────
    const hfPrimaryOk = !!r.hazard_factor_code && validHf.has(r.hazard_factor_code);
    const dtPrimaryOk = !!r.damage_type_primary && validDt.has(r.damage_type_primary);
    const droppedThis =
      [r.hazard_factor_code, ...(r.hazard_factor_sub ?? [])].filter((c) => c && !validHf.has(c)).length +
      [r.damage_type_primary, ...(r.damage_type_codes ?? [])].filter((c) => c && !validDt.has(c)).length;
    droppedCodes += droppedThis;

    let hfPrimary = r.hazard_factor_code;
    let hfExtra: string[] = r.hazard_factor_sub ?? [];
    let dtPrimary = r.damage_type_primary;
    let dtExtra: string[] = r.damage_type_codes ?? [];
    let llmFix: Awaited<ReturnType<typeof tagCase>> | null = null;

    if (!hfPrimaryOk || !dtPrimaryOk) {
      try {
        llmFix = await tagCase(
          { itemName: r.product_name, title: r.product_name, narrative: narrativeOf(r) },
          snapshot,
        );
        if (!hfPrimaryOk) { hfPrimary = llmFix.output.hf_primary; hfExtra = llmFix.output.hf_secondary; }
        if (!dtPrimaryOk) { dtPrimary = llmFix.output.dt_primary; dtExtra = llmFix.output.dt_secondary; }
      } catch (e) {
        console.warn(`  경고: LLM 재분류 실패 recall_cache#${cache.id} ${r.source}:${r.guid}: ${e instanceof Error ? e.message : e}`);
      }
    }

    const hfAll = dedupeValid([hfPrimary, ...hfExtra], validHf);
    const dtAll = dedupeValid([dtPrimary, ...dtExtra], validDt);
    const hfOk = !!hfPrimary && validHf.has(hfPrimary);
    const dtOk = !!dtPrimary && validDt.has(dtPrimary);

    if (hfOk && dtOk) {
      const adminEvidence = (r.hazard_description ?? r.recall_cause ?? '').slice(0, 2000);
      const hfFromLlm = !hfPrimaryOk;
      const dtFromLlm = !dtPrimaryOk;

      const tagRows = [
        ...hfAll.map((code) => ({ axis: 'HF' as const, code, is_primary: code === hfPrimary, fromLlm: hfFromLlm })),
        ...dtAll.map((code) => ({ axis: 'DT' as const, code, is_primary: code === dtPrimary, fromLlm: dtFromLlm })),
      ].map((t) =>
        t.fromLlm && llmFix
          ? {
              case_id: ev.id, axis: t.axis, code: t.code, is_primary: t.is_primary,
              confidence_score: llmFix.output.confidence_score,
              agreement_score: llmFix.agreementScore,
              evidence_span: llmFix.output.evidence_span || adminEvidence,
              // LLM이 채운 축은 담당자 검수 대상으로 표시한다 — 관리자값은 approved 그대로
              review_status: 'auto_unreviewed',
              tagging_version: `${taggingVersion}+LLMFIX`,
              tagging_model: llmFix.model,
              codebook_version: snapshot.version,
            }
          : {
              case_id: ev.id, axis: t.axis, code: t.code, is_primary: t.is_primary,
              // 사람(담당자)이 승인한 값이라 AI 반복호출의 "일치도" 개념이 없다 — 1로 둔다
              confidence_score: 1,
              agreement_score: null,
              evidence_span: adminEvidence,
              review_status: 'approved',
              tagging_version: taggingVersion,
              tagging_model: 'recall_hub_admin',
              codebook_version: snapshot.version,
            },
      );

      await db.begin(async (tx) => {
        await tx`
          insert into public.case_tag ${tx(
            tagRows as never,
            'case_id', 'axis', 'code', 'is_primary', 'confidence_score',
            'agreement_score', 'evidence_span', 'review_status',
            'tagging_version', 'tagging_model', 'codebook_version',
          )}
          on conflict (case_id, axis, code, tagging_version) do nothing
        `;
        const codeLabels = [...hfAll, ...dtAll].map((c) => labels.get(c) ?? c);
        const searchText = buildCaseSearchText(
          { itemName: r.product_name, title: r.product_name, narrative: narrativeOf(r), chunkSummary: null, codeLabels },
          variant,
        );
        await tx`
          update public.case_event
          set search_text = ${searchText}, embedding = null, embedding_model = null
          where id = ${ev.id}
        `;
      });
      tagged++;
      if (llmFix) {
        llmReclassified.push({
          cacheId: cache.id, source: r.source, guid: r.guid,
          from: [!hfPrimaryOk ? r.hazard_factor_code : null, !dtPrimaryOk ? r.damage_type_primary : null]
            .filter(Boolean).join(', '),
          to: [!hfPrimaryOk ? hfPrimary : null, !dtPrimaryOk ? dtPrimary : null]
            .filter(Boolean).join(', '),
        });
      }
    } else {
      // tagCase() 는 코드북 enum만 반환하므로 이 분기는 이론상 오지 않는다
      // (LLM 호출 자체가 실패했을 때만의 안전망)
      unclassified.push({
        cacheId: cache.id, source: r.source, guid: r.guid,
        hf: r.hazard_factor_code, dt: r.damage_type_primary,
      });
    }
  }

  console.log('');
  console.log(`캐시 저장       : ${cached}건`);
  console.log(`사건 행         : 신규 ${newCase}건 / 기존 ${existingCase}건`);
  console.log(`품목 확정       : ${resolved}건`);
  console.log(`코드화          : ${tagged}건 (관리자값 ${tagged - llmReclassified.length} · LLM 재분류 ${llmReclassified.length})`);
  console.log(`KC 기준 대조    : ${withStd}건 — 공고에 명시된 위반 표준이 우리 기준과 번호가 같은 경우`);
  if (droppedCodes > 0) {
    console.log(`코드북에 없어 버린 부코드 : ${droppedCodes}개 (주코드는 LLM이 재분류했으므로 부코드만 버려짐)`);
  }
  if (llmReclassified.length > 0) {
    console.log('');
    console.log(`LLM 재분류(관리자 코드가 코드북에 없어 대체) : ${llmReclassified.length}건 — review_status='auto_unreviewed'로 검수 대상`);
    for (const u of llmReclassified.slice(0, 20)) {
      console.log(`  recall_cache#${u.cacheId} ${u.source}:${u.guid}  ${u.from} → ${u.to}`);
    }
    if (llmReclassified.length > 20) console.log(`  ... 외 ${llmReclassified.length - 20}건`);
  }
  if (unclassified.length > 0) {
    console.log('');
    console.log(`미분류(LLM 재분류도 실패) : ${unclassified.length}건 — 담당자 확인 필요`);
    for (const u of unclassified.slice(0, 20)) {
      console.log(`  recall_cache#${u.cacheId} ${u.source}:${u.guid}  HF=${u.hf ?? '(없음)'} DT=${u.dt ?? '(없음)'}`);
    }
    if (unclassified.length > 20) console.log(`  ... 외 ${unclassified.length - 20}건`);
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
