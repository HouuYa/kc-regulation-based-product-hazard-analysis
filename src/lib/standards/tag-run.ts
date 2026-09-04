/**
 * L1 조항 태깅 — 명령줄과 화면 버튼이 함께 쓰는 실행부
 *
 * 태깅은 준비, 매칭은 사용이다(§1.1 원칙 1).
 * 이 배치를 미리 돌려 두었기 때문에 조회가 빠르고 매번 같다.
 *
 * 검수 확정분은 덮어쓰지 않는다 (§3.3)
 *   "사람이 검수 확정한 태깅은 자동 재태깅으로 덮어쓰지 않고, 차이만 표시하여
 *    담당자에게 확인 요청한다." retag 도 review_status='approved' 는 건드리지 않는다.
 *
 * 검색 대상 조항만 태깅한다 (v0.7 §5.3)
 *   적용범위·정의·표·그림은 직접 후보가 아니므로 태깅 비용을 쓰지 않는다.
 *
 * 시간 예산(timeBudgetMs)이 있는 이유 — 이 파일이 생긴 이유이기도 하다
 *   운영 화면에서 코드 부여를 시작할 수 있게 하면서 생겼다. 남은 요건 조항
 *   5,884건은 건당 AI 를 3~4번 부르므로(1건당 약 $0.0022, 전체 약 $13) 웹 요청
 *   하나로 다 돌 수가 없다. 그래서 개수가 아니라 "시간"으로 끊는다 — 모델이
 *   느려지면 적게, 빠르면 많이 처리하고 남은 것은 다음 차례에 넘긴다.
 *   한 건을 처리하는 도중에 끊지는 않는다 — 그러면 조항이 반쯤 처리된 채 남는다.
 */

import { getDb } from '../db';
import { loadCodebookSnapshot, validateCodes, codeLabelMap } from '../codebook/snapshot';
import { tagClause, toTagRows } from '../llm/tagging';
import { buildClauseSearchText, buildContextHeader, type SearchTextVariant } from '../search/search-text';
import { openaiConfig, tuning } from '../env';

/**
 * 요건 조항만 태깅한다 (v0.7 §5.3)
 *
 * 역할은 clause_role 컬럼에 이미 매겨져 있다(npm run standards:roles).
 * 정의·적용범위를 태깅하면 안 되는 이유는 비용이 아니라 오염이다 —
 * 아무것도 요구하지 않는 정의문이 진짜 안전요건과 같은 자격으로 검색에 걸린다.
 * 시험방법은 clause_link 로 도달하므로 코드를 붙일 필요가 없다.
 */
export const TAGGABLE_ROLE = 'REQUIREMENT';

/**
 * 연속 실패가 이만큼 쌓이면 자동 대상에서 뺀다 (029)
 *
 * 실패한 조항은 clause_tag 에 아무것도 남기지 않으므로, 조건이 "태그가 없는 조항"인
 * 한 대기줄 맨 앞에 영원히 남는다. 순서가 (standard_id, order_index) 로 고정이라
 * 자리가 밀리지도 않는다 — offset=0 요청이 매 분 같은 조항부터 다시 부른다.
 * 그러면 자동 실행이 스스로 꺼지지도 않고(남은 건수가 0 이 안 되므로) 돈만 나간다.
 *
 * 3인 이유: 태깅은 조항 하나에 AI 를 3~4회 부른다. 일시적인 요청 한도 초과라면
 * 다음 차례에 성공한다. 세 번 연속 실패하면 조항이나 프롬프트의 문제일 가능성이
 * 높으므로 사람이 봐야 한다.
 */
export const MAX_TAG_FAILURES = 3;

/**
 * 태깅 대상의 조건. 남은 건수를 세는 곳과 실제로 가져오는 곳이 함께 쓴다.
 *
 * 두 곳에 각자 적어 두면 한쪽만 고치게 되고, 그러면 "화면에는 남았다는데 실제로
 * 처리할 것은 없는" 상태가 된다. 그 상태에서는 자동 실행이 영원히 돈다.
 * 029 의 run_tag_chunk() 도 같은 조건을 쓴다 — 세 곳이 반드시 같아야 한다.
 */
function taggableWhere(
  db: ReturnType<typeof getDb>,
  standardFilter: string | null,
  retag: boolean,
) {
  return db`
    s.is_current
      and length(btrim(c.body)) >= 15
      and c.clause_role = ${TAGGABLE_ROLE}
      and c.tag_fail_count < ${MAX_TAG_FAILURES}
      ${standardFilter ? db`and s.display_name ilike ${'%' + standardFilter + '%'}` : db``}
      ${retag
        ? db`and not exists (
              select 1 from public.clause_tag t
              where t.clause_id = c.id and t.review_status = 'approved')`
        : db`and not exists (select 1 from public.clause_tag t where t.clause_id = c.id)`}
  `;
}

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

export interface TagRunOptions {
  standardFilter?: string | null;
  limit?: number | null;
  retag?: boolean;
  /** 이 시간을 넘기면 남은 건을 두고 멈춘다(화면 버튼용). null 이면 끝까지 */
  timeBudgetMs?: number | null;
  /** 동시에 처리할 조항 수. 기본은 tuning().taggingConcurrency */
  concurrency?: number;
  /**
   * 대상 목록의 앞에서 이만큼 건너뛰고 시작한다.
   *
   * 여러 요청이 동시에 돌 때 서로 다른 구간을 맡게 하려는 것이다. 같은 조항을
   * 두 번 처리하면 돈이 두 배로 나가므로, 한 요청이 실제로 처리하는 건수보다
   * 훨씬 큰 간격을 두고 나눈다(027 참고).
   */
  offset?: number;
  onProgress?: (done: number, total: number, ok: number, fail: number) => void;
}

export interface TagRunResult {
  target: number;
  ok: number;
  fail: number;
  escalated: number;
  disagreed: number;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number };
  taggingVersion: string;
  codebookVersion: string;
  /** 시간 예산에 걸려 남기고 멈췄는가 */
  stoppedEarly: boolean;
  errors: string[];
}

/** 아직 코드가 붙지 않은 요건 조항이 몇 건인가 — 화면이 남은 일과 비용을 보여 줄 때 쓴다 */
export async function countTaggable(standardFilter?: string | null, retag = false): Promise<number> {
  const db = getDb();
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n
    from public.clause c
    join public.standard s on s.id = c.standard_id
    where ${taggableWhere(db, standardFilter ?? null, retag)}
  `;
  return row.n;
}

/**
 * 세 번 연속 실패해 자동 대상에서 빠진 조항이 몇 건인가
 *
 * 남은 건수와 반드시 따로 보여 준다. "0건 남음"만 보고 담당자가 손을 떼면
 * 실패분이 묻힌다 — 끝난 것과 포기한 것은 다른 상태다.
 */
export async function countStalledTagging(standardFilter?: string | null): Promise<number> {
  const db = getDb();
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n
    from public.clause c
    join public.standard s on s.id = c.standard_id
    where s.is_current
      and length(btrim(c.body)) >= 15
      and c.clause_role = ${TAGGABLE_ROLE}
      and c.tag_fail_count >= ${MAX_TAG_FAILURES}
      ${standardFilter ? db`and s.display_name ilike ${'%' + standardFilter + '%'}` : db``}
      and not exists (select 1 from public.clause_tag t where t.clause_id = c.id)
  `;
  return row.n;
}

export async function runTagging(opts: TagRunOptions = {}): Promise<TagRunResult> {
  const {
    standardFilter = null, limit = null, retag = false,
    timeBudgetMs = null, offset = 0, onProgress,
  } = opts;
  const db = getDb();
  const variant = tuning().searchTextVariant as SearchTextVariant;
  const started = Date.now();

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
    where ${taggableWhere(db, standardFilter, retag)}
    order by c.standard_id, c.order_index
    ${limit ? db`limit ${limit}` : db``}
    ${offset ? db`offset ${offset}` : db``}
  `;

  const cfg = openaiConfig();
  const snapshot = await loadCodebookSnapshot();
  const labels = codeLabelMap(snapshot);
  const t = tuning();

  // 프롬프트·모델·규칙 묶음의 판번호. 부분 재태깅과 성능 비교의 기준이 된다(§2.3 결정 B)
  const taggingVersion =
    `L1-${cfg.bulkModel}x${t.bulkRepeat}+${cfg.escalateModel}-${snapshot.version}-${variant}`;

  const result: TagRunResult = {
    target: rows.length, ok: 0, fail: 0, escalated: 0, disagreed: 0,
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    taggingVersion, codebookVersion: snapshot.version, stoppedEarly: false, errors: [],
  };
  if (rows.length === 0) return result;

  const [run] = await db<{ id: number }[]>`
    insert into public.tagging_run
      (tagging_version, target_scope, model, repeat_count, codebook_version, clause_count)
    values (${taggingVersion}, ${standardFilter}, ${cfg.bulkModel},
            ${t.bulkRepeat}, ${snapshot.version}, ${rows.length})
    returning id
  `;

  // 여러 건을 동시에 처리한다
  //
  //   실측: 한 건에 약 17.8초(AI 를 3~4번 순서대로 부른다). 순서대로만 하면
  //   남은 5,896건에 약 29시간이 걸려 "눌러 두면 알아서 끝나는" 것이 불가능했다.
  //   조항끼리는 서로를 참조하지 않고 저장도 건별 트랜잭션이라 동시에 해도 안전하다.
  //   동시 4건이면 같은 일이 약 7시간으로 줄어 밤새 두면 끝난다.
  //
  //   너무 올리면 OpenAI 요청 한도에 걸려 오히려 실패가 늘므로 기본값을 낮게 두고
  //   환경변수로 조절한다(TAGGING_CONCURRENCY).
  const lanes = Math.max(1, opts.concurrency ?? t.taggingConcurrency);
  let cursor = 0;
  let doneCount = 0;

  async function worker() {
    for (;;) {
      // 시간 예산 확인은 건 처리를 시작하기 전에만 한다 — 도중에 끊으면
      // 조항이 반쯤 처리된 채 남는다
      if (timeBudgetMs != null && Date.now() - started > timeBudgetMs) {
        result.stoppedEarly = true;
        return;
      }
      const i = cursor++;
      if (i >= rows.length) return;
      await processOne(rows[i]);
      doneCount++;
      onProgress?.(doneCount, rows.length, result.ok, result.fail);
    }
  }

  /**
   * 실패를 조항에 적는다 (029)
   *
   * 기록 자체가 실패해도 태깅 결과는 그대로 둔다 — 실패를 적다가 또 실패했다고
   * 배치를 세울 이유는 없다. 다만 조용히 넘기면 같은 조항이 계속 돌게 되므로
   * 로그에는 남긴다.
   */
  async function recordFailure(clauseId: number, reason: string) {
    try {
      await db`
        update public.clause
        set tag_fail_count = tag_fail_count + 1,
            tag_last_error = ${reason.slice(0, 2000)},
            tag_failed_at  = now()
        where id = ${clauseId}
      `;
    } catch (e) {
      console.error(`실패 기록 실패 (조항 ${clauseId}):`, e);
    }
  }

  async function processOne(c: ClauseRow) {
    const header = buildContextHeader({
      itemName: c.item_name,
      standardLabel: c.display_name,
      breadcrumbPath: c.breadcrumb_path,
      marker: c.marker,
      body: c.body,
    });

    try {
      const tagged = await tagClause(
        { contextHeader: header, marker: c.marker, body: c.body, testConditions: c.test_conditions ?? undefined },
        snapshot,
      );

      if (tagged.escalated) result.escalated++;
      if (tagged.escalationDisagreed) result.disagreed++;
      result.usage.inputTokens += tagged.usage.inputTokens;
      result.usage.outputTokens += tagged.usage.outputTokens;
      result.usage.reasoningTokens += tagged.usage.reasoningTokens;

      const tagRows = toTagRows(tagged);
      const hf = tagRows.filter((x) => x.axis === 'HF').map((x) => x.code);
      const dt = tagRows.filter((x) => x.axis === 'DT').map((x) => x.code);

      // enum 을 통과했어도 한 번 더 검증한다 (§5.2.2)
      const check = await validateCodes(hf, dt, snapshot.version);
      if (!check.ok) {
        // 반복문이 아니라 함수가 됐으므로 continue 가 아니라 return 이다
        const reason = `코드북에 없는 코드: ${check.errors.join(' / ')}`;
        result.errors.push(`거부 ${c.marker}: ${check.errors.join(' / ')}`);
        result.fail++;
        // 이 실패는 다시 불러도 같은 결과가 나올 가능성이 높다. 반드시 세어 둔다
        await recordFailure(c.id, reason);
        return;
      }

      // 태깅 결과를 재료로 검색용 텍스트를 조립한다.
      // 순서에 유의 — 태깅이 끝난 뒤에야 분류명과 요약이 생긴다(§2.2)
      const codeLabels = [...hf, ...dt].map((code) => labels.get(code) ?? code);
      const searchText = buildClauseSearchText(
        {
          itemName: c.item_name, standardLabel: c.display_name,
          breadcrumbPath: c.breadcrumb_path, clauseType: c.clause_type,
          marker: c.marker, body: c.body,
          chunkSummary: tagged.output.chunk_summary,
          codeLabels, testConditions: c.test_conditions ?? undefined,
        },
        variant,
      );

      // 태그를 축별 행으로 편다 (v0.7 §5.2 — 한 행에 HF/DT 를 같이 두지 않는다).
      //
      // json_to_recordset 을 쓰지 않는 이유: postgres.js 는 json 캐스팅을 만나면
      // 값을 스스로 직렬화한다. 이미 JSON.stringify 한 문자열을 넘기면 두 번
      // 인코딩되어 배열이 아니라 문자열 스칼라가 되고, DB 가 거부한다.
      const tagInsertRows = tagRows.map((x) => ({
        clause_id: c.id, axis: x.axis, code: x.code, is_primary: x.is_primary,
        confidence_score: x.confidence_score, agreement_score: x.agreement_score,
        evidence_span: tagged.output.evidence_span,
        tagging_version: taggingVersion, tagging_model: tagged.model,
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
              chunk_summary       = ${tagged.output.chunk_summary},
              keywords            = ${tagged.output.keywords}::text[],
              search_text         = ${searchText},
              search_text_variant = ${variant},
              -- 검색용 텍스트가 바뀌었으므로 임베딩은 무효다. 다시 만들어야 한다(§3.4)
              embedding           = null,
              embedding_model     = null,
              embedded_at         = null,
              -- 성공했으므로 실패 이력을 지운다. 어쩌다 한 번 실패한 조항이
              -- 이력을 계속 지고 다니지 않게 한다 — "연속" 실패 횟수다(029)
              tag_fail_count      = 0,
              tag_last_error      = null,
              tag_failed_at       = null
          where id = ${c.id}
        `;
      });

      result.ok++;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      result.fail++;
      result.errors.push(`실패 ${c.marker}: ${reason}`);
      await recordFailure(c.id, reason);
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => worker()));

  await db`
    update public.tagging_run
    set ok_count = ${result.ok}, fail_count = ${result.fail}, finished_at = now()
    where id = ${run.id}
  `;

  return result;
}
