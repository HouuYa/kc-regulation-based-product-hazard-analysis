/**
 * L2 사건 코드화 + 품목 확정 + 검색 재료 조립
 *
 *   npm run cases:code                  확정된 사건 중 코드가 없는 것
 *   npm run cases:code -- --case 33
 *   npm run cases:code -- --all         미확정 사건도 포함
 *   npm run cases:code -- --dry         호출 없이 대상만 센다
 *   npm run cases:code -- --source-type RECALL_OVERSEAS --all
 *
 * 리콜도 사건 행이므로 같은 경로를 탄다(004 스키마의 source_type). Recall Hub 는
 * 위해요인 코드를 주지 않으므로(013 주석) 해외 리콜도 여기서 우리가 붙인다.
 *
 * v0.7 §7.1 의 처리 순서 중 1~3 단계를 담당한다.
 *   1 품목 식별  2 적용 기준 선택  3 데이터 완전성 확인
 * 그 뒤 4~6(후보 생성·융합·관계 확장)은 npm run search 가 한다.
 *
 * 순서가 중요하다 (v0.7 §3.2)
 *   "위해요인 코드가 같아도 제품이 다르면 관련 시험이 다르다."
 *   그래서 코드부터 붙이고 품목을 나중에 보는 것이 아니라, 품목을 먼저 확정한다.
 *   확정하지 못하면 product_scope_id 를 비워 두고 분석에서 막는다 —
 *   전 품목 검색을 자동으로 돌리면 다른 제품의 시험이 섞인다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { loadCodebookSnapshot, validateCodes, codeLabelMap } from '../src/lib/codebook/snapshot';
import { tagCase, toTagRows } from '../src/lib/llm/tagging';
import { buildCaseSearchText, type SearchTextVariant } from '../src/lib/search/search-text';
import { openaiConfig, tuning } from '../src/lib/env';
import { resolveProductScope } from '../src/lib/cases/resolve-scope';
import { extractItemName } from '../src/lib/cases/item-name';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

interface CaseRow {
  id: number;
  title: string | null;
  narrative: string;
  item_name: string | null;
  extracted_text: string | null;
  source_file_id: number | null;
}

/**
 * 사진에서 찾은 위해요인 단서를 사건 서술 뒤에 붙인다 (068)
 *
 * 텍스트만 코드화하면 "시험 적합"으로만 끝나 원인을 못 찾는 사건이 있다 —
 * 실측(전기방석 사건, source_file 103): 원문은 "시험 항목 모두 적합"뿐이라
 * HF.UNKNOWN 으로 끝났지만, 사진에는 "전선 피복이 끊긴 듯한 틈과 노출 구간"이
 * 보였다. 068에서 사진 비전 분석(source_file_image.hazard_note)을 붙였으니
 * 코드화 모델도 그것을 함께 보게 한다.
 *
 * evidence_span 무결성에 대한 타협
 *   이 체계는 evidence_span이 "원문에서 그대로 인용한 구간"이어야 한다고
 *   못박아 왔다(docs/AI_사용_관리.md §3). 사진 관찰은 AI(비전 모델)가 만든
 *   문장이지 원문이 아니므로, 코드화 모델이 거기서 evidence_span을 뽑으면 그
 *   전제가 흔들린다. 스키마에 별도 필수 필드를 만들지 않는 한 완전히 막을
 *   방법은 없어, 블록을 "원문 인용이 아니다"로 분명히 표시해 두는 것으로
 *   타협한다 — 검수하는 사람이 evidence_span이 이 블록에서 왔는지 원문에서
 *   왔는지 최소한 구분할 수는 있어야 한다.
 *
 * 아직 비전 분석이 안 끝난 사건(job-photo-vision 이 꺼져 있거나 순서가
 * 아직 안 왔을 때)은 hazard_note 가 전부 null 이라 빈 문자열을 돌려주고,
 * 코드화는 전과 같이 서술만으로 진행된다 — 실패가 아니라 자연스러운 대기 상태다.
 */
async function photoHazardContext(
  db: ReturnType<typeof getDb>,
  sourceFileId: number | null,
): Promise<{ text: string; count: number }> {
  if (!sourceFileId) return { text: '', count: 0 };
  const rows = await db<{ page_number: number; hazard_note: string }[]>`
    select page_number, hazard_note
    from public.source_file_image
    where source_file_id = ${sourceFileId}
      and hazard_note is not null and length(btrim(hazard_note)) > 0
    order by page_number
  `;
  if (rows.length === 0) return { text: '', count: 0 };
  const lines = rows.map((r) => `- ${r.page_number}쪽: ${r.hazard_note}`).join('\n');
  return {
    text: `\n\n[AI가 첨부 사진에서 관찰한 것 — 원문 인용이 아니라 비전 분석 결과다]\n${lines}`,
    count: rows.length,
  };
}

async function main() {
  const onlyCase = argValue('--case') ? Number(argValue('--case')) : null;
  const includeUnconfirmed = process.argv.includes('--all');
  const sourceType = argValue('--source-type');
  const dry = process.argv.includes('--dry');

  const db = getDb();
  const variant = tuning().searchTextVariant as SearchTextVariant;

  const rows = await db<CaseRow[]>`
    select e.id, e.title, e.narrative, e.item_name, f.extracted_text, e.source_file_id
    from public.case_event e
    left join public.source_file f on f.id = e.source_file_id
    where not exists (select 1 from public.case_tag t where t.case_id = e.id)
      ${onlyCase ? db`and e.id = ${onlyCase}` : db``}
      ${includeUnconfirmed ? db`` : db`and e.is_confirmed`}
      ${sourceType ? db`and e.source_type = ${sourceType}` : db``}
    order by e.id
  `;

  console.log(`코드화 대상 : ${rows.length}건${sourceType ? ` (${sourceType})` : ``}`);
  if (!includeUnconfirmed) {
    console.log('  (확정된 사건만. 미확정도 포함하려면 --all)');
  }
  if (dry || rows.length === 0) {
    for (const r of rows) {
      console.log(`  [${r.id}] ${r.title} — 품목추정 "${extractItemName(r.extracted_text) ?? '못찾음'}"`);
    }
    return;
  }

  const cfg = openaiConfig();
  const snapshot = await loadCodebookSnapshot();
  const labels = codeLabelMap(snapshot);
  const taggingVersion =
    `L2-${cfg.bulkModel}x${tuning().bulkRepeat}+${cfg.escalateModel}-${snapshot.version}-${variant}`;

  console.log(`코드북      : ${snapshot.version}`);
  console.log(`판번호      : ${taggingVersion}`);

  let ok = 0, fail = 0, resolved = 0, unresolved = 0;

  for (const c of rows) {
    try {
      // ── 1단계: 품목 확정 (v0.7 §3.2) ──────────────────────────────────
      const itemName = c.item_name ?? extractItemName(c.extracted_text);
      // 사건 서술을 함께 넘긴다 — 품목 이름만으로는 신호가 짧아 의미 검색이 흔들린다
      const scope = itemName ? await resolveProductScope(itemName, c.narrative) : null;

      if (scope) {
        resolved++;
        await db`
          update public.case_event
          set item_name = ${itemName},
              product_scope_id = ${scope.productScopeId},
              scope_evidence = ${scope.evidence}
          where id = ${c.id}
        `;
        console.log(`  [${c.id}] 품목 "${itemName}" → ${scope.scopeName} (기준 ${scope.standardCount}건, ${scope.method})`);
      } else {
        unresolved++;
        if (itemName) await db`update public.case_event set item_name = ${itemName} where id = ${c.id}`;
        console.log(`  [${c.id}] 품목 "${itemName ?? '미상'}" → 적용기준을 찾지 못함 (SCOPE_UNRESOLVED)`);
      }

      // ── 2단계: 코드화 ────────────────────────────────────────────────
      // 품목이 미확정이어도 코드는 붙인다. 코드가 있어야 나중에 품목이 확정됐을 때
      // 바로 분석할 수 있고, 트랙 B 통계에도 쓰인다.
      const photo = await photoHazardContext(db, c.source_file_id);
      const result = await tagCase(
        { itemName, title: c.title, narrative: c.narrative.slice(0, 12000) + photo.text },
        snapshot,
        c.id,
      );
      if (photo.count > 0) console.log(`     사진 관찰 ${photo.count}건을 함께 검토했습니다`);

      const tagRows = toTagRows(result);
      const hf = tagRows.filter((t) => t.axis === 'HF').map((t) => t.code);
      const dt = tagRows.filter((t) => t.axis === 'DT').map((t) => t.code);

      const check = await validateCodes(hf, dt, snapshot.version);
      if (!check.ok) {
        console.error(`     거부: ${check.errors.join(' / ')}`);
        fail++;
        continue;
      }
      for (const w of check.warnings) console.warn(`     경고: ${w}`);

      const codeLabels = [...hf, ...dt].map((code) => labels.get(code) ?? code);
      const searchText = buildCaseSearchText(
        {
          itemName,
          title: c.title,
          narrative: c.narrative,
          chunkSummary: result.output.chunk_summary,
          codeLabels,
        },
        variant,
      );

      const tagInsertRows = tagRows.map((t) => ({
        case_id: c.id,
        axis: t.axis,
        code: t.code,
        is_primary: t.is_primary,
        confidence_score: t.confidence_score,
        agreement_score: t.agreement_score,
        evidence_span: result.output.evidence_span,
        tagging_version: taggingVersion,
        tagging_model: result.model,
        codebook_version: snapshot.version,
      }));

      await db.begin(async (tx) => {
        await tx`
          insert into public.case_tag ${tx(
            tagInsertRows as never,
            'case_id', 'axis', 'code', 'is_primary', 'confidence_score',
            'agreement_score', 'evidence_span', 'tagging_version',
            'tagging_model', 'codebook_version',
          )}
          on conflict (case_id, axis, code, tagging_version) do nothing
        `;
        await tx`
          update public.case_event
          set chunk_summary = ${result.output.chunk_summary},
              keywords      = ${result.output.keywords}::text[],
              search_text   = ${searchText},
              embedding     = null,
              embedding_model = null
          where id = ${c.id}
        `;
      });

      console.log(
        `     HF ${result.output.hf_primary} / DT ${result.output.dt_primary}` +
          ` · 확신 ${result.output.confidence_score} 일치 ${result.agreementScore.toFixed(2)}` +
          (result.escalated ? ` · 승격(${result.model})` : ''),
      );
      ok++;
    } catch (e) {
      fail++;
      console.error(`  [${c.id}] 실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log('');
  console.log(`코드화 완료 : 성공 ${ok} / 실패 ${fail}`);
  console.log(`품목 확정   : ${resolved}건 / 미확정 ${unresolved}건`);
  if (unresolved > 0) {
    console.log('  미확정 사건은 분석을 실행하지 않습니다. 전 품목 검색을 자동으로 돌리면');
    console.log('  다른 제품의 시험이 섞이기 때문입니다(v0.7 §3.2).');
  }
  console.log('다음        : npm run embed -- --cases');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
