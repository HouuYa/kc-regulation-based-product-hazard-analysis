/**
 * 해외 리콜 적재 — 트랙 B 의 입구
 *
 * 2026-09-02 부터 Recall Hub 의 얇은 REST API 대신 원본 표를 직접 읽는다
 * (src/lib/recall/source.ts). 담당자가 검토·승인(approval_status)까지 마치고
 * 위해요인(HF-DT)까지 분류해 둔 값을 그대로 쓴다 — 그래서 이 함수가 한 번에 다 한다.
 *
 *   1) recall_cache 에 원본을 통째로 보관한다(§7.1 원본층, raw 포함).
 *   2) case_event 에 source_type='RECALL_OVERSEAS' 로 승격한다.
 *   3) 품목을 확정한다(resolveProductScope) — tag-cases.ts 의 1단계와 같다.
 *   4) 관리자가 이미 붙인 HF-DT 코드로 case_tag 를 채운다. AI 호출 없음.
 *
 * 관리자 주코드가 우리 코드북에 없을 때(예: v0.9에서 이미 폐기된 HF.S.STD)
 * 더는 "미분류"로 남기지 않고 그 축만 tagCase() 로 다시 채운다. tagCase() 는
 * 코드북 스냅샷에서 뽑은 enum만 반환하므로 무효 코드가 나올 수 자체가 없다.
 * 이렇게 채운 축은 review_status='auto_unreviewed' 로 표시해 검수 대상임을 남긴다
 * (원본 관리자값은 'approved').
 *
 * 왜 스크립트가 아니라 여기 있는가 (2026-09-03 이동)
 *   담당자 요청으로 리콜 수집이 하루 1회 자동 실행된다. 자동 실행 경로(API 라우트)와
 *   명령줄이 같은 로직을 써야 하므로 src/lib 으로 옮겼다(CLAUDE.md §9).
 *   scripts/load-recalls.ts 는 이제 인자 해석과 출력만 맡는다.
 *
 * AI 호출이 없다는 말의 정확한 뜻
 *   기본 경로에는 없다. 관리자 코드가 우리 코드북에 없을 때만 그 건에 한해
 *   tagCase() 를 부른다. 자동 실행에서도 마찬가지이므로 비용이 0 은 아니지만,
 *   실측상 대부분의 건은 코드가 맞아 호출이 일어나지 않는다.
 */

import { getDb } from '../db';
import { fetchApprovedRecalls, type SourceRecall } from './source';
import { crosswalk } from './crosswalk';
import { loadCodebookSnapshot, codeLabelMap } from '../codebook/snapshot';
import { buildCaseSearchText, type SearchTextVariant } from '../search/search-text';
import { resolveProductScope } from '../cases/resolve-scope';
import { tagCase } from '../llm/tagging';
import { tuning } from '../env';

export interface LoadRecallsResult {
  received: number;
  cached: number;
  newCase: number;
  existingCase: number;
  resolved: number;
  tagged: number;
  withStd: number;
  droppedCodes: number;
  llmReclassified: Array<{ cacheId: number; source: string; guid: string; from: string; to: string }>;
  unclassified: Array<{ cacheId: number; source: string; guid: string; hf: string | null; dt: string | null }>;
  warnings: string[];
  /** 시간 예산에 걸려 남기고 멈췄는가 (033) */
  stoppedEarly: boolean;
}

/** 검색·매칭이 읽을 서술문을 만든다. 원본 표가 주는 서술 필드를 최대한 붙인다 */
export function narrativeOf(r: SourceRecall): string {
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

export async function loadRecalls(
  opts: {
    source?: string; limit?: number; offset?: number;
    /**
     * 이 시간을 넘기면 남은 건을 두고 멈춘다 (033)
     *
     * 왜 건수만으로는 부족한가 — 실제로 겪은 일이다. 028 이 배치를 10건으로
     * 정했는데, 배포 환경의 실측이 `4,100 + 2,875 × 건수` ms 여서 10건은
     * 32,850ms 였다. 제한이 약 30초이므로 자료가 있는 구간은 예외 없이
     * 시간 초과로 죽었고, 그 상태로 52번을 돌 때까지 아무도 몰랐다.
     *
     * 033 이 건수를 5로 낮춰 지금은 여유가 있다. 그러나 건당 비용은 앞으로
     * 바뀐다 — 코드북에 없는 코드가 늘면 AI 재분류가 늘고, 외부 조회가 느려지면
     * 그만큼 는다. 그때 다시 절벽 너머로 넘어가지 않도록, 건수뿐 아니라 시간으로도
     * 끊는다. tag-chunk 가 이미 같은 방식이다(tag-run.ts).
     *
     * 한 건을 처리하는 도중에 끊지는 않는다. 그러면 리콜이 반쯤 처리된 채 남는다.
     */
    timeBudgetMs?: number | null;
  } = {},
): Promise<LoadRecallsResult> {
  const db = getDb();
  const result: LoadRecallsResult = {
    received: 0, cached: 0, newCase: 0, existingCase: 0, resolved: 0, tagged: 0,
    withStd: 0, droppedCodes: 0, llmReclassified: [], unclassified: [], warnings: [],
    stoppedEarly: false,
  };
  const started = Date.now();
  const timeBudgetMs = opts.timeBudgetMs ?? null;

  const rows = await fetchApprovedRecalls({ source: opts.source, limit: opts.limit, offset: opts.offset });
  result.received = rows.length;
  if (rows.length === 0) return result;

  const snapshot = await loadCodebookSnapshot({ includeUncommon: true });
  const labels = codeLabelMap(snapshot);
  const validHf = new Set(snapshot.hf.map((o) => o.code));
  const validDt = new Set(snapshot.dt.map((o) => o.code));
  const variant = tuning().searchTextVariant as SearchTextVariant;
  const taggingVersion = `ADMIN-recall_hub-${snapshot.version}`;

  /*
    한 건을 한 트랜잭션으로 (02_1차 보완 및 구현 설계서 §4.5)

    전에는 캐시 저장·사건 생성·캐시의 사건 연결·품목 확정·태그 저장을 각각 따로
    보냈다. 중간에서 끊기면 캐시만 있고 사건이 없거나, 사건은 있는데 검색용 문장과
    태그가 없는 상태가 남는다. 그런 행은 화면에 정상으로 보이면서 검색에는 걸리지
    않으므로 담당자가 알아채기 어렵다.

    다만 트랜잭션을 연 채로 바깥일(기준 대조·품목 조회·AI 호출)을 기다리면 안 된다.
    AI 호출은 초 단위라 그동안 연결과 잠금을 붙들고 있게 된다. 그래서 순서를
    뒤집었다 — 느린 바깥일을 먼저 다 끝내고, DB 쓰기만 마지막에 한 번에 모은다.
  */
  for (const r of rows) {
    // 예산 확인은 새 건을 시작하기 전에만 한다 — 도중에 끊으면 반쯤 처리된 채 남는다
    if (timeBudgetMs != null && Date.now() - started > timeBudgetMs) {
      result.stoppedEarly = true;
      break;
    }

    const externalRef = `${r.source}:${r.guid}`;

    try {
      // ── ① 바깥일 먼저: 기준 대조 ────────────────────────────────────────────
      const cw = await crosswalk([r.hazard_description, r.recall_cause].filter(Boolean).join(' '));

      // ── ② 바깥일: 품목 확정 (v0.7 §3.2, tag-cases.ts 1단계와 동일) ──────────
      const scope = r.product_name ? await resolveProductScope(r.product_name) : null;

      // ── ③ 바깥일: 관리자 HF-DT 코드가 코드북에 있으면 그대로 쓴다.
      //    없는 축만 tagCase()로 다시 채운다(2단 반복+승격, AI 호출은 축이 무효일 때만)
      const hfPrimaryOk = !!r.hazard_factor_code && validHf.has(r.hazard_factor_code);
      const dtPrimaryOk = !!r.damage_type_primary && validDt.has(r.damage_type_primary);
      const dropped =
        [r.hazard_factor_code, ...(r.hazard_factor_sub ?? [])].filter((c) => c && !validHf.has(c)).length +
        [r.damage_type_primary, ...(r.damage_type_codes ?? [])].filter((c) => c && !validDt.has(c)).length;

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
          result.warnings.push(
            `LLM 재분류 실패 ${externalRef}: ${e instanceof Error ? e.message : e}`,
          );
        }
      }

      const hfAll = dedupeValid([hfPrimary, ...hfExtra], validHf);
      const dtAll = dedupeValid([dtPrimary, ...dtExtra], validDt);
      const hfOk = !!hfPrimary && validHf.has(hfPrimary);
      const dtOk = !!dtPrimary && validDt.has(dtPrimary);

      // 태그 행은 사건 번호만 빼고 미리 만들어 둔다. 번호는 트랜잭션 안에서 붙인다
      const adminEvidence = (r.hazard_description ?? r.recall_cause ?? '').slice(0, 2000);
      const tagSpecs =
        hfOk && dtOk
          ? [
              ...hfAll.map((code) => ({ axis: 'HF' as const, code, is_primary: code === hfPrimary, fromLlm: !hfPrimaryOk })),
              ...dtAll.map((code) => ({ axis: 'DT' as const, code, is_primary: code === dtPrimary, fromLlm: !dtPrimaryOk })),
            ]
          : [];

      const codeLabels = [...hfAll, ...dtAll].map((c) => labels.get(c) ?? c);
      const searchText = buildCaseSearchText(
        { itemName: r.product_name, title: r.product_name, narrative: narrativeOf(r), chunkSummary: null, codeLabels },
        variant,
      );

      const rawFields = {
        source: r.source, country: r.recall_country,
        hazard_type: r.hazard_type, source_url: r.source_url,
        cited_standards: cw.cited.map((c) => c.raw), crosswalk_note: cw.note,
      };

      // ── ④ DB 쓰기는 여기서 한 번에 ─────────────────────────────────────────
      const outcome = await db.begin(async (tx) => {
        // 원본층 — 표 전체를 raw 에 통째로 보관한다(§7.1). 파생 컬럼이 늘어도
        // 다시 받아 올 필요가 없다
        const [cache] = await tx<{ id: number }[]>`
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
            ${tx.json(r as never)}, now()
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

        /*
          사건 행으로 승격 — 트랙 A 와 같은 엔진을 타기 위한 통로.
          external_ref 유니크 인덱스(014)로 재실행해도 중복이 안 생긴다.

          전에는 이미 있으면 do nothing 이었다. 그래서 원본에서 제목이나 위해
          설명이 고쳐져도 사건 쪽은 옛 문장 그대로였다. 이제 원본에서 온 필드는
          갱신한다. 다만 is_confirmed·product_scope_id 처럼 담당자가 손댄 값은
          건드리지 않는다 — 원본을 다시 받았다는 이유로 사람의 판단을 지울 수는 없다.
        */
        let [ev] = await tx<{ id: number }[]>`
          insert into public.case_event (
            source_type, external_ref, title, narrative, item_name, model_name,
            occurred_on, raw_fields, is_confirmed
          ) values (
            'RECALL_OVERSEAS', ${externalRef}, ${r.product_name},
            ${narrativeOf(r)}, ${r.product_name}, ${r.model_name},
            ${r.published_date}, ${tx.json(rawFields as never)},
            false
          )
          on conflict (source_type, external_ref) where external_ref is not null do nothing
          returning id
        `;
        const isNew = !!ev;

        if (!ev) {
          [ev] = await tx<{ id: number }[]>`
            update public.case_event
            set title       = ${r.product_name},
                narrative   = ${narrativeOf(r)},
                item_name   = ${r.product_name},
                model_name  = ${r.model_name},
                occurred_on = ${r.published_date},
                raw_fields  = ${tx.json(rawFields as never)}
            where source_type = 'RECALL_OVERSEAS' and external_ref = ${externalRef}
            returning id
          `;
        }
        // 이론상 오지 않는다 — 방금 넣었거나 방금 갱신했다. 그래도 조용히 넘기지
        // 않는다: 트랜잭션을 되돌려 캐시만 남는 상태를 만들지 않는다
        if (!ev) throw new Error('사건 행을 만들지도 찾지도 못했습니다');
        const caseId = ev.id;

        await tx`update public.recall_cache set case_id = ${caseId} where id = ${cache.id}`;

        if (scope) {
          await tx`
            update public.case_event
            set product_scope_id = ${scope.productScopeId}, scope_evidence = ${scope.evidence}
            where id = ${caseId}
          `;
        }

        if (tagSpecs.length > 0) {
          const tagRows = tagSpecs.map((t) =>
            t.fromLlm && llmFix
              ? {
                  case_id: caseId, axis: t.axis, code: t.code, is_primary: t.is_primary,
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
                  case_id: caseId, axis: t.axis, code: t.code, is_primary: t.is_primary,
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

          await tx`
            insert into public.case_tag ${tx(
              tagRows as never,
              'case_id', 'axis', 'code', 'is_primary', 'confidence_score',
              'agreement_score', 'evidence_span', 'review_status',
              'tagging_version', 'tagging_model', 'codebook_version',
            )}
            on conflict (case_id, axis, code, tagging_version) do nothing
          `;

          /*
            검색용 문장이 실제로 바뀌었을 때만 의미 검색 준비를 다시 시킨다

            전에는 무조건 embedding = null 이었다. 리콜 수집은 5분마다 구간을 돌며
            전체를 약 42시간 주기로 다시 훑으므로, 바뀐 것이 없어도 모든 리콜의
            임베딩이 주기마다 통째로 날아가고 다시 만들어졌다. 2,252건이 이유 없이
            반복 과금되고 있었다는 뜻이다.

            update 문에서 등호 왼쪽이 아닌 자리의 컬럼 이름은 갱신 전 값을 가리킨다.
            그래서 한 문장 안에서 옛 문장과 새 문장을 비교할 수 있다.
          */
          await tx`
            update public.case_event
            set search_text     = ${searchText},
                embedding       = case when search_text is distinct from ${searchText}
                                       then null else embedding end,
                embedding_model = case when search_text is distinct from ${searchText}
                                       then null else embedding_model end
            where id = ${caseId}
          `;
        }

        return { cacheId: cache.id, isNew };
      });

      // ── ⑤ 집계는 트랜잭션이 끝난 뒤에만 올린다 ──────────────────────────────
      //    중간에 실패한 건이 처리된 것처럼 세어지면 운영 숫자가 거짓말을 한다
      result.cached++;
      result.droppedCodes += dropped;
      if (cw.standardIds.length) result.withStd++;
      if (outcome.isNew) result.newCase++;
      else result.existingCase++;
      if (scope) result.resolved++;

      if (tagSpecs.length > 0) {
        result.tagged++;
        if (llmFix) {
          result.llmReclassified.push({
            cacheId: outcome.cacheId, source: r.source, guid: r.guid,
            from: [!hfPrimaryOk ? r.hazard_factor_code : null, !dtPrimaryOk ? r.damage_type_primary : null]
              .filter(Boolean).join(', '),
            to: [!hfPrimaryOk ? hfPrimary : null, !dtPrimaryOk ? dtPrimary : null]
              .filter(Boolean).join(', '),
          });
        }
      } else {
        // tagCase() 는 코드북 enum만 반환하므로 이 분기는 이론상 오지 않는다
        // (LLM 호출 자체가 실패했을 때만의 안전망)
        result.unclassified.push({
          cacheId: outcome.cacheId, source: r.source, guid: r.guid,
          hf: r.hazard_factor_code, dt: r.damage_type_primary,
        });
      }
    } catch (e) {
      // 한 건이 실패해도 나머지는 계속한다. 어느 건이 왜 막혔는지만 남긴다 —
      // 트랜잭션이 되돌아갔으므로 이 리콜의 흔적은 DB 에 남지 않는다
      result.warnings.push(`적재 실패 ${externalRef}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return result;
}
