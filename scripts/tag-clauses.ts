/**
 * L1 조항 태깅 배치
 *
 *   npm run tag -- --standard "부속서 8"        기준 하나
 *   npm run tag -- --standard "부속서 8" --limit 20
 *   npm run tag -- --standard "부속서 8" --dry   호출 없이 대상만 센다
 *   npm run tag -- --retag                       이미 태깅된 조항도 다시
 *
 * 태깅은 준비, 매칭은 사용이다(§1.1 원칙 1).
 * 이 배치를 미리 돌려 두었기 때문에 조회가 빠르고 매번 같다.
 *
 * 검수 확정분은 덮어쓰지 않는다 (§3.3)
 *   "사람이 검수 확정한 태깅은 자동 재태깅으로 덮어쓰지 않고, 차이만 표시하여
 *    담당자에게 확인 요청한다." --retag 도 review_status='approved' 는 건드리지 않는다.
 *
 * 검색 대상 조항만 태깅한다 (v0.7 §5.3)
 *   적용범위·정의·표·그림은 직접 후보가 아니므로 태깅 비용을 쓰지 않는다.
 */

import { getDb, closeDb } from '../src/lib/db.js';
import { loadCodebookSnapshot, validateCodes, codeLabelMap } from '../src/lib/codebook/snapshot.js';
import { tagClause, toTagRows } from '../src/lib/llm/tagging.js';
import { buildClauseSearchText, buildContextHeader, type SearchTextVariant } from '../src/lib/search/search-text.js';
import { openaiConfig, tuning } from '../src/lib/env.js';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/**
 * 직접 후보가 되지 않는 조항 유형 (v0.7 §5.3)
 * 표(LT)·그림(LF)·비고(LN)는 시험방법의 상세 근거로 제공될 뿐 후보가 아니다.
 */
const NON_CANDIDATE_LEVELS = ['LT', 'LF', 'LN', 'L1', 'L2'];

interface ClauseRow {
  id: number;
  marker: string;
  part: string | null;
  breadcrumb_path: string | null;
  level_code: string | null;
  clause_type: string | null;
  body: string;
  item_name: string | null;
  display_name: string | null;
  test_conditions: string[] | null;
}

async function main() {
  const standardFilter = argValue('--standard');
  const limit = Number(argValue('--limit') ?? '0') || null;
  const dry = process.argv.includes('--dry');
  const retag = process.argv.includes('--retag');

  const db = getDb();
  const variant = tuning().searchTextVariant as SearchTextVariant;

  const rows = await db<ClauseRow[]>`
    select
      c.id, c.marker, c.part, c.breadcrumb_path, c.level_code, c.clause_type, c.body,
      s.item_name, s.display_name,
      (select array_agg(
         tc.item_name || ' ' || coalesce(tc.allowance_raw, '')
         order by tc.id)
       from public.test_condition tc where tc.clause_id = c.id) as test_conditions
    from public.clause c
    join public.standard s on s.id = c.standard_id
    where s.is_current
      and length(btrim(c.body)) >= 15
      and not (c.level_code = any (${NON_CANDIDATE_LEVELS}::text[]))
      ${standardFilter ? db`and s.display_name ilike ${'%' + standardFilter + '%'}` : db``}
      ${retag
        ? db`and not exists (
              select 1 from public.clause_tag t
              where t.clause_id = c.id and t.review_status = 'approved')`
        : db`and not exists (select 1 from public.clause_tag t where t.clause_id = c.id)`}
    order by c.standard_id, c.order_index
    ${limit ? db`limit ${limit}` : db``}
  `;

  console.log(`태깅 대상 : ${rows.length}건${standardFilter ? ` (${standardFilter})` : ''}`);
  console.log(`조립 변형 : ${variant}`);

  if (dry) {
    console.log('(--dry) 호출하지 않고 종료합니다.');
    for (const r of rows.slice(0, 5)) console.log(`  ${r.marker} ${r.body.slice(0, 50)}`);
    return;
  }
  if (rows.length === 0) return;

  const cfg = openaiConfig();
  const snapshot = await loadCodebookSnapshot();
  const labels = codeLabelMap(snapshot);
  console.log(`코드북    : ${snapshot.version} (HF ${snapshot.hf.length} / DT ${snapshot.dt.length})`);

  // 프롬프트·모델·규칙 묶음의 판번호. 부분 재태깅과 성능 비교의 기준이 된다(§2.3 결정 B)
  const taggingVersion = `L1-${cfg.taggingModel}-${snapshot.version}-${variant}`;

  const [run] = await db<{ id: number }[]>`
    insert into public.tagging_run
      (tagging_version, target_scope, model, repeat_count, codebook_version, clause_count)
    values (${taggingVersion}, ${standardFilter}, ${cfg.taggingModel},
            ${tuning().repeatCount}, ${snapshot.version}, ${rows.length})
    returning id
  `;

  let ok = 0;
  let fail = 0;

  for (const [i, c] of rows.entries()) {
    const header = buildContextHeader({
      itemName: c.item_name,
      standardLabel: c.display_name,
      breadcrumbPath: c.breadcrumb_path,
      marker: c.marker,
      body: c.body,
    });

    try {
      const result = await tagClause(
        {
          contextHeader: header,
          marker: c.marker,
          body: c.body,
          testConditions: c.test_conditions ?? undefined,
        },
        snapshot,
        cfg.taggingModel,
      );

      const tagRows = toTagRows(result);
      const hf = tagRows.filter((t) => t.axis === 'HF').map((t) => t.code);
      const dt = tagRows.filter((t) => t.axis === 'DT').map((t) => t.code);

      // enum 을 통과했어도 한 번 더 검증한다 (§5.2.2)
      const check = await validateCodes(hf, dt, snapshot.version);
      if (!check.ok) {
        console.error(`  거부 ${c.marker}: ${check.errors.join(' / ')}`);
        fail++;
        continue;
      }

      // 태깅 결과를 재료로 검색용 텍스트를 조립한다.
      // 순서에 유의 — 태깅이 끝난 뒤에야 분류명과 요약이 생긴다(§2.2)
      const codeLabels = [...hf, ...dt].map((code) => labels.get(code) ?? code);
      const searchText = buildClauseSearchText(
        {
          itemName: c.item_name,
          standardLabel: c.display_name,
          breadcrumbPath: c.breadcrumb_path,
          clauseType: c.clause_type,
          marker: c.marker,
          body: c.body,
          chunkSummary: result.output.chunk_summary,
          codeLabels,
          testConditions: c.test_conditions ?? undefined,
        },
        variant,
      );

      await db.begin(async (tx) => {
        await tx`
          insert into public.clause_tag
            (clause_id, axis, code, is_primary, confidence_score, agreement_score,
             evidence_span, tagging_version, tagging_model, codebook_version)
          select ${c.id}, x.axis, x.code, x.is_primary, x.conf, x.agree,
                 ${result.output.evidence_span}, ${taggingVersion},
                 ${cfg.taggingModel}, ${snapshot.version}
          from json_to_recordset(${JSON.stringify(
            tagRows.map((t) => ({
              axis: t.axis, code: t.code, is_primary: t.is_primary,
              conf: t.confidence_score, agree: t.agreement_score,
            })),
          )}::json)
            as x(axis text, code text, is_primary boolean, conf numeric, agree numeric)
          on conflict (clause_id, axis, code, tagging_version) do nothing
        `;

        await tx`
          update public.clause
          set context_header      = ${buildContextHeader({
                itemName: c.item_name, standardLabel: c.display_name,
                breadcrumbPath: c.breadcrumb_path, marker: c.marker, body: c.body,
                codeLabels,
              })},
              chunk_summary       = ${result.output.chunk_summary},
              keywords            = ${result.output.keywords}::text[],
              search_text         = ${searchText},
              search_text_variant = ${variant},
              -- 검색용 텍스트가 바뀌었으므로 임베딩은 무효다. 다시 만들어야 한다(§3.4)
              embedding           = null,
              embedding_model     = null,
              embedded_at         = null
          where id = ${c.id}
        `;
      });

      ok++;
      if ((i + 1) % 20 === 0 || i === rows.length - 1) {
        process.stdout.write(`  진행 ${i + 1}/${rows.length} (성공 ${ok} 실패 ${fail})\n`);
      }
    } catch (e) {
      fail++;
      console.error(`  실패 ${c.marker}: ${e instanceof Error ? e.message : e}`);
    }
  }

  await db`
    update public.tagging_run
    set ok_count = ${ok}, fail_count = ${fail}, finished_at = now()
    where id = ${run.id}
  `;

  console.log('');
  console.log(`태깅 완료 : 성공 ${ok} / 실패 ${fail} (tagging_version = ${taggingVersion})`);
  console.log('다음      : npm run embed  — 검색용 텍스트가 바뀌었으므로 임베딩을 다시 만듭니다.');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
