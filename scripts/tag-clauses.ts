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

import { getDb, closeDb } from '../src/lib/db';
import { loadCodebookSnapshot, validateCodes, codeLabelMap } from '../src/lib/codebook/snapshot';
import { tagClause, toTagRows } from '../src/lib/llm/tagging';
import { buildClauseSearchText, buildContextHeader, type SearchTextVariant } from '../src/lib/search/search-text';
import { openaiConfig, tuning } from '../src/lib/env';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/**
 * 요건 조항만 태깅한다 (v0.7 §5.3)
 *
 * 역할은 clause_role 컬럼에 이미 매겨져 있다(npm run standards:roles).
 * 정의·적용범위를 태깅하면 안 되는 이유는 비용이 아니라 오염이다 —
 * "가량이 벨트란 …장치를 말한다"에 HF.M.DES 가 붙으면, 아무것도 요구하지 않는
 * 정의문이 진짜 안전요건과 같은 자격으로 검색에 걸린다.
 * 시험방법은 clause_link 로 도달하므로 코드를 붙일 필요가 없다.
 */
const TAGGABLE_ROLE = 'REQUIREMENT';

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
      and c.clause_role = ${TAGGABLE_ROLE}
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
  // 2단 구조이므로 두 모델을 모두 판번호에 넣는다 — 나중에 "어느 조합으로 붙인
  // 태깅인가"를 판번호만 보고 알 수 있어야 하기 때문이다.
  const t = tuning();
  const taggingVersion =
    `L1-${cfg.bulkModel}x${t.bulkRepeat}+${cfg.escalateModel}-${snapshot.version}-${variant}`;
  console.log(`1차 모델  : ${cfg.bulkModel} (reasoning ${cfg.bulkEffort}) × ${t.bulkRepeat}회`);
  console.log(`승격 모델 : ${cfg.escalateModel} (reasoning ${cfg.escalateEffort}) — 일치도 ${t.escalateBelowAgreement} 미만일 때`);

  const [run] = await db<{ id: number }[]>`
    insert into public.tagging_run
      (tagging_version, target_scope, model, repeat_count, codebook_version, clause_count)
    values (${taggingVersion}, ${standardFilter}, ${cfg.bulkModel},
            ${t.bulkRepeat}, ${snapshot.version}, ${rows.length})
    returning id
  `;

  let ok = 0;
  let fail = 0;
  let escalatedCount = 0;
  let disagreedCount = 0;
  const usageTotal = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };

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
      );

      if (result.escalated) escalatedCount++;
      if (result.escalationDisagreed) disagreedCount++;
      usageTotal.inputTokens += result.usage.inputTokens;
      usageTotal.outputTokens += result.usage.outputTokens;
      usageTotal.reasoningTokens += result.usage.reasoningTokens;

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

      // 태그를 축별 행으로 편다 (v0.7 §5.2 — 한 행에 HF/DT 를 같이 두지 않는다).
      //
      // json_to_recordset 을 쓰지 않는 이유: postgres.js 는 json 캐스팅을 만나면
      // 값을 스스로 직렬화한다. 이미 JSON.stringify 한 문자열을 넘기면 두 번
      // 인코딩되어 배열이 아니라 문자열 스칼라가 되고, DB 가
      // "cannot call json_to_recordset on a scalar" 로 거부한다.
      // 저장소의 다른 적재 코드와 같이 postgres.js 의 다중행 삽입 헬퍼를 쓴다.
      const tagInsertRows = tagRows.map((t) => ({
        clause_id: c.id,
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
          insert into public.clause_tag ${tx(
            tagInsertRows as never,
            'clause_id', 'axis', 'code', 'is_primary', 'confidence_score',
            'agreement_score', 'evidence_span', 'tagging_version',
            'tagging_model', 'codebook_version',
          )}
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

  // 2단 구조가 실제로 어떻게 갈렸는지 남긴다.
  // 승격률이 예상(15%)보다 훨씬 높으면 1차 모델이나 프롬프트를 손봐야 한다는 신호이고,
  // 반대로 0% 에 가까우면 승격 임계값이 느슨한 것이다.
  if (ok > 0) {
    const rate = ((escalatedCount / ok) * 100).toFixed(1);
    console.log(`승격      : ${escalatedCount}/${ok}건 (${rate}%) — 1차 반복이 일치하지 않아 상위 모델로`);
    console.log(`  그중 상위 모델이 1차 다수결과 다른 답 : ${disagreedCount}건`);
    if (disagreedCount > 0) {
      console.log('  이 건들이 검수 최우선 대상입니다(§5.2.3 "가장 위험한 구간").');
    }
  }
  console.log(
    `토큰      : 입력 ${usageTotal.inputTokens.toLocaleString()} / ` +
      `출력 ${usageTotal.outputTokens.toLocaleString()}` +
      `(사고 ${usageTotal.reasoningTokens.toLocaleString()})`,
  );
  console.log('다음      : npm run embed  — 검색용 텍스트가 바뀌었으므로 임베딩을 다시 만듭니다.');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
