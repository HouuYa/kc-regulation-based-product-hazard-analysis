import Link from 'next/link';
import { getDb } from '@/lib/db';
import { standardsForCase } from '@/lib/cases/resolve-scope';
import { EvidenceStrip, type EvidenceLevel, type MatchPath } from '@/components/EvidenceStrip';
import { recordReview } from './actions';
import { REJECT_REASONS } from './review-options';

export const dynamic = 'force-dynamic';

/**
 * 화면 D — 사건 분석 (설계문서 §8.4)
 *
 * "판정하지 않는다"의 UI 번역이 이 화면의 전부다.
 *
 *   위반 판정 금지  →  문구를 "관련될 수 있음 / 확인 권고"로 고정, 적색 아이콘 미사용
 *   근거 제시      →  조항 원문·시험조건·매칭 경로·재채점 이유를 펼쳐 보기로 제공
 *   HITL 확정      →  채택/반려가 기본 동작, 아무것도 안 하면 미확정으로 남는다
 *   폴백 명시      →  미태깅 품목 결과는 별도 배지로 구분
 *   누락 방지      →  상위 5건 우선 표시, 나머지는 '더 보기'로 항상 열어 둔다
 *
 * 마지막 항목이 특히 중요하다. 사고조사에서 시험 항목 누락은 되돌릴 수 없는 손실이므로
 * 시스템이 임의로 감추면 안 된다(§5.6.3).
 */

const SHORTLIST = 5;

/** src/lib/gpc/lookup.ts 의 GpcCandidate 를 그대로 저장한 것 (case_event.raw_fields.gpc_candidates) */
interface GpcCandidate {
  rank: number;
  brickCode: string;
  brickTitle: string;
  classCode: string;
  classTitle: string;
  familyCode: string;
  familyTitle: string;
  segmentCode: string;
  segmentTitle: string;
  similarity: number;
}

interface ResultRow {
  id: number;
  clause_id: number;
  search_score: string;
  match_path: MatchPath;
  rank_code: number | null;
  rank_keyword: number | null;
  rank_vector: number | null;
  rerank_score: string | null;
  rerank_reason: string | null;
  final_rank: number;
  marker: string;
  breadcrumb_path: string | null;
  body: string;
  standard_name: string | null;
  has_reviewed_tag: boolean;
  codes: string[] | null;
  test_conditions: string[] | null;
  test_methods: Array<{ marker: string; body: string | null }> | null;
  decision: string | null;
  reject_reason: string | null;
}

function evidenceLevelOf(p: MatchPath, reviewed: boolean): EvidenceLevel {
  if (p === 'FALLBACK') return 'C';
  if ((p === 'CODE' || p === 'CODE-PARTIAL') && reviewed) return 'A';
  return 'B';
}

async function load(caseId: number) {
  const db = getDb();

  const [ev] = await db<{
    id: number; title: string | null; narrative: string; item_name: string | null;
    source_type: string; occurred_on: string | null;
    product_scope_id: number | null; scope_evidence: string | null; basis_date: string | null;
    scope_name: string | null;
    gpc_brick_code: string | null; gpc_candidates: GpcCandidate[] | null;
  }[]>`
    select e.id, e.title, e.narrative, e.item_name, e.source_type, e.occurred_on::text,
           e.product_scope_id, e.scope_evidence, e.basis_date::text,
           ps.name as scope_name,
           e.gpc_brick_code, e.raw_fields->'gpc_candidates' as gpc_candidates
    from public.case_event e
    left join public.product_scope ps on ps.id = e.product_scope_id
    where e.id = ${caseId}
  `;
  if (!ev) return null;

  // 이 사건에 적용되는 기준. 품목 확정의 결과이자 검색 범위 그 자체다(v0.7 §3.2).
  // 명령줄 분석과 같은 함수를 쓴다 — 화면과 실제 검색 범위가 어긋나면 안 된다.
  const standardIds = await standardsForCase(caseId);
  const standards = standardIds.length
    ? await db<{ display_name: string; relation: string | null }[]>`
        select s.display_name,
               (select a.relation from public.standard_applicability a
                where a.standard_id = s.id and a.product_scope_id = ${ev.product_scope_id}
                limit 1) as relation
        from public.standard s
        where s.id = any(${standardIds}::bigint[])
        order by s.display_name
      `
    : [];

  // 해외 리콜이면 트랙 B 의 재료를 함께 싣는다
  const [recall] = ev.source_type === 'RECALL_OVERSEAS'
    ? await db<{
        source: string; guid: string; recall_country: string | null;
        hazard_type: string | null; detail_url: string | null;
        cited_standards: string[]; matched_standard_ids: number[]; domestic_check: string;
      }[]>`
        select source, guid, recall_country, hazard_type, detail_url,
               cited_standards, matched_standard_ids, domestic_check
        from public.recall_cache where case_id = ${caseId} limit 1
      `
    : [];

  const tags = await db<{ axis: string; code: string; is_primary: boolean }[]>`
    select axis, code, is_primary from public.case_tag
    where case_id = ${caseId} and review_status <> 'rejected'
    order by is_primary desc, axis, code
  `;

  const [run] = await db<{
    id: number; started_at: string; use_code: boolean; use_keyword: boolean;
    use_vector: boolean; use_rerank: boolean; result_count: number;
    rerank_model: string | null; embedding_model: string | null;
  }[]>`
    select id, started_at::text, use_code, use_keyword, use_vector, use_rerank,
           result_count, rerank_model, embedding_model
    from public.match_run where case_id = ${caseId}
    order by started_at desc limit 1
  `;

  const results = run
    ? await db<ResultRow[]>`
        select
          r.id, r.clause_id, r.search_score, r.match_path,
          r.rank_code, r.rank_keyword, r.rank_vector,
          r.rerank_score, r.rerank_reason, r.final_rank,
          c.marker, c.breadcrumb_path, c.body,
          s.display_name as standard_name,
          exists (select 1 from public.clause_tag t
                  where t.clause_id = c.id and t.review_status = 'approved') as has_reviewed_tag,
          (select array_agg(t.code order by t.is_primary desc, t.axis)
           from public.clause_tag t where t.clause_id = c.id) as codes,
          (select array_agg(tc.item_name || ' ' || coalesce(tc.allowance_raw,'') order by tc.id)
           from public.test_condition tc where tc.clause_id = c.id) as test_conditions,
          (select json_agg(json_build_object('marker', l.to_marker, 'body', tm.body))
           from public.clause_link l
           left join public.clause tm on tm.id = l.to_clause_id
           where l.from_clause_id = c.id and l.link_type = 'TEST_METHOD') as test_methods,
          (select rl.decision from public.review_log rl
           where rl.match_result_id = r.id order by rl.created_at desc limit 1) as decision,
          (select rl.reject_reason from public.review_log rl
           where rl.match_result_id = r.id order by rl.created_at desc limit 1) as reject_reason
        from public.match_result r
        join public.clause c   on c.id = r.clause_id
        join public.standard s on s.id = c.standard_id
        where r.run_id = ${run.id}
        order by r.final_rank
      `
    : [];

  return { ev, tags, run, results, standards, recall };
}

/**
 * 원인(HF)이 확정되지 않았는가.
 *
 * 사고조사에서 결함을 찾지 못한 사건이 실제로 있다 — 보고서에 "제품 시험 결과
 * 안전기준에 적합", "특이사항을 식별하지 못함"이라고 적힌 경우다. 이때 결과(DT)만
 * 가지고 특정 시험을 지목하면 근거 없는 지목이 된다(v0.7 §7.3).
 */
function causeUnresolved(codes: string[]): boolean {
  return codes.filter((c) => c && c !== 'HF.UNKNOWN').length === 0;
}

function Candidate({ r, caseId }: { r: ResultRow; caseId: number }) {
  const decided = r.decision != null;

  return (
    <article
      className={`border-t border-rule py-5 ${decided ? 'opacity-60' : ''}`}
      id={`r-${r.id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="flex items-baseline gap-2.5">
          <span className="addr text-[17px] font-medium">{r.marker}</span>
          <span className="text-[12px] text-ink-3">{r.standard_name}</span>
        </h3>
        <span className="addr tnum text-[11px] text-ink-3">
          {Number(r.search_score).toFixed(4)}
          {r.rerank_score != null && ` · 재채점 ${Number(r.rerank_score).toFixed(2)}`}
        </span>
      </div>

      <div className="mt-2">
        <EvidenceStrip
          rankCode={r.rank_code}
          rankKeyword={r.rank_keyword}
          rankVector={r.rank_vector}
          matchPath={r.match_path}
          evidenceLevel={evidenceLevelOf(r.match_path, r.has_reviewed_tag)}
        />
      </div>

      {r.breadcrumb_path && (
        <div className="addr mt-2.5 text-[11px] text-ink-3">{r.breadcrumb_path}</div>
      )}

      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-ink-2">{r.body}</p>

      {r.rerank_reason && (
        <p className="mt-2.5 max-w-3xl border-l-2 border-rule pl-3 text-[12px] leading-relaxed text-ink-2">
          {r.rerank_reason}
        </p>
      )}

      {r.codes?.length ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {r.codes.map((c) => (
            <span key={c} className="addr border border-rule px-1.5 py-0.5 text-[11px] text-ink-2">
              {c}
            </span>
          ))}
        </div>
      ) : null}

      {r.test_methods?.length ? (
        <div className="mt-3 border-l-2 border-measure bg-measure-soft/40 px-3 py-2">
          <div className="label text-measure">시험방법</div>
          {r.test_methods.map((tm, i) => (
            <div key={i} className="mt-1 text-[12px] leading-snug">
              <span className="addr font-medium">{tm.marker}</span>
              <span className="ml-2 text-ink-2">
                {tm.body ? tm.body.slice(0, 120) : '이 기준에 없습니다 — 다른 기준을 참조합니다'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-[12px] text-caution">
          시험방법 연결이 없습니다. 조항은 찾았으나 어떤 시험을 의뢰할지는 직접 확인해야 합니다.
        </div>
      )}

      {r.test_conditions?.length ? (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink">
            시험조건 {r.test_conditions.length}건 보기
          </summary>
          <ul className="addr tnum mt-1.5 space-y-0.5 text-[11px] text-ink-2">
            {r.test_conditions.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </details>
      ) : null}

      {decided ? (
        <div className="mt-3 text-[12px]">
          <span className={r.decision === 'ADOPTED' ? 'text-measure' : 'text-ink-3'}>
            {r.decision === 'ADOPTED' ? '채택함' : r.decision === 'REJECTED' ? '반려함' : '수정함'}
          </span>
          {r.reject_reason && (
            <span className="ml-2 text-ink-3">
              — {REJECT_REASONS.find((x) => x.value === r.reject_reason)?.label}
            </span>
          )}
        </div>
      ) : (
        <form action={recordReview} className="mt-3.5 flex flex-wrap items-center gap-2">
          <input type="hidden" name="matchResultId" value={r.id} />
          <input type="hidden" name="caseId" value={caseId} />
          <button
            type="submit" name="decision" value="ADOPTED"
            className="border border-measure bg-measure px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-85"
          >
            채택
          </button>
          <select
            name="rejectReason"
            defaultValue="NOT_RELATED"
            aria-label="반려 사유"
            className="border border-rule bg-surface px-2 py-1.5 text-[12px] text-ink-2"
          >
            {REJECT_REASONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            type="submit" name="decision" value="REJECTED"
            className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft"
          >
            반려
          </button>
        </form>
      )}
    </article>
  );
}

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId: raw } = await params;
  const caseId = Number(raw);

  let data: Awaited<ReturnType<typeof load>> = null;
  let error: string | null = null;
  try {
    data = await load(caseId);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10">
        <div className="border border-halt bg-halt-soft px-5 py-4 text-[13px] text-halt">
          데이터를 불러오지 못했습니다. <span className="addr text-ink-2">{error}</span>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10">
        <p className="text-[13px] text-ink-2">사건 {raw} 이 없습니다.</p>
        <Link href="/cases" className="mt-2 inline-block text-[13px] text-measure underline">
          사건 목록으로
        </Link>
      </div>
    );
  }

  const { ev, tags, run, results, standards, recall } = data;
  const shortlist = results.slice(0, SHORTLIST);
  const rest = results.slice(SHORTLIST);
  const hfUnresolved = tags.length > 0
    && causeUnresolved(tags.filter((t) => t.axis === 'HF').map((t) => t.code));

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
      <header>
        <div className="label">
          사건 {ev.id} · {ev.source_type === 'ACCIDENT' ? '사고보고서' : '리콜'}
          {ev.occurred_on && ` · ${ev.occurred_on}`}
        </div>
        <h1 className="mt-2 max-w-2xl text-[24px] leading-snug font-semibold tracking-tight">
          {ev.title ?? ev.narrative.slice(0, 60)}
        </h1>
        <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-ink-2">{ev.narrative}</p>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="label mr-1">부여 코드</span>
          {tags.length === 0 && <span className="text-[12px] text-caution">코드화되지 않음</span>}
          {tags.map((t) => (
            <span
              key={`${t.axis}${t.code}`}
              className={`addr border px-1.5 py-0.5 text-[11px] ${
                t.is_primary ? 'border-measure text-measure' : 'border-rule text-ink-2'
              }`}
            >
              {t.code}
            </span>
          ))}
        </div>
      </header>

      {/* 품목·적용기준 — 검색보다 먼저 결정되는 것이므로 후보 목록보다 위에 둔다 */}
      <section className="mt-6 border-t border-rule pt-5">
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <span className="label">품목·적용기준</span>
          <div className="text-[13px] leading-relaxed">
            {ev.product_scope_id || ev.item_name ? (
              <>
                <div>
                  <span className="font-medium">{ev.scope_name ?? ev.item_name}</span>
                  {ev.basis_date && (
                    <span className="ml-2 text-[11px] text-ink-3">기준일 {ev.basis_date}</span>
                  )}
                </div>
                {ev.scope_evidence && (
                  <p className="mt-1 text-[12px] text-ink-2">{ev.scope_evidence}</p>
                )}
                {standards.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {standards.map((s) => (
                      <span key={s.display_name} className="addr border border-rule px-1.5 py-0.5 text-[11px] text-ink-2">
                        {s.display_name}
                        {s.relation && <span className="ml-1 text-ink-3">{s.relation === 'ANNEX' ? '부속서' : '공통'}</span>}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="border border-caution bg-caution-soft px-3 py-2 text-[12px] leading-relaxed text-caution">
                <strong className="font-semibold">품목 미확정 (SCOPE_UNRESOLVED)</strong>
                <p className="mt-1">
                  적용할 기준을 정하지 못해 분석을 실행하지 않습니다. 전 품목을 뒤지면 다른
                  제품의 시험이 섞이기 때문입니다. 품목을 등록한 뒤 다시 실행하세요.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* GPC(GS1 국제 품목분류) 후보 — 사고사진 비전 분석에서 뽑은 제품 서술로 조회한 것.
          절대 유사도가 낮아(src/lib/gpc/lookup.ts 참고) 1위를 확정으로 보여주지 않고
          순위 목록으로만 제시한다 — 이 화면의 "판정하지 않는다" 원칙과 같다. */}
      {ev.gpc_candidates && ev.gpc_candidates.length > 0 && (
        <section className="mt-4 border-t border-rule pt-5">
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <span className="label">GPC 품목분류 후보</span>
            <div className="text-[13px] leading-relaxed">
              <p className="text-[12px] text-ink-3">
                사고사진 분석에서 뽑은 제품 서술로 조회한 순위입니다. 절대 유사도가 낮아
                1위가 항상 맞는 것은 아니니 순위 전체를 참고해 사람이 확인하세요.
              </p>
              <ul className="mt-2 space-y-1">
                {ev.gpc_candidates.map((c) => (
                  <li
                    key={c.rank}
                    className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 py-1 text-[12px] ${
                      c.brickCode === ev.gpc_brick_code ? 'border border-measure text-measure' : 'text-ink-2'
                    }`}
                  >
                    <span className="addr tnum text-ink-3">{c.rank}위</span>
                    <span className="addr">{c.brickCode}</span>
                    <span className="font-medium">{c.brickTitle}</span>
                    <span className="text-ink-3">
                      {c.segmentTitle} &gt; {c.familyTitle} &gt; {c.classTitle}
                    </span>
                    <span className="addr tnum ml-auto text-ink-3">{c.similarity.toFixed(3)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* 트랙 B — 해외 리콜에만 있는 것들 */}
      {recall && (
        <section className="mt-4 border-t border-rule pt-5">
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <span className="label">해외 리콜</span>
            <div className="text-[13px] leading-relaxed">
              <div className="addr text-[12px] text-ink-2">
                {recall.source} {recall.guid}
                {recall.recall_country && ` · ${recall.recall_country}`}
                {recall.detail_url && (
                  <>
                    {' · '}
                    <a href={recall.detail_url} target="_blank" rel="noreferrer"
                       className="text-measure underline">원문</a>
                  </>
                )}
              </div>
              {recall.hazard_type && <p className="mt-1">{recall.hazard_type}</p>}

              <div className="mt-3">
                <span className="label">상대국 근거</span>
                {recall.cited_standards.length === 0 ? (
                  <p className="mt-1 text-[12px] text-ink-2">
                    공고에 위반 표준이 명시되지 않았습니다. 해외 리콜의 72%가 여기 해당하며,
                    이 경우 국가 간 기준 수준 비교는 할 수 없습니다.
                  </p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {recall.cited_standards.map((s) => (
                      <span key={s} className="addr border border-rule px-1.5 py-0.5 text-[11px] text-ink-2">{s}</span>
                    ))}
                    <span className="text-[11px] text-ink-3">
                      {recall.matched_standard_ids.length > 0
                        ? `· 우리 기준 ${recall.matched_standard_ids.length}건과 번호가 같습니다`
                        : '· 우리 기준과 번호 체계가 달라 사람이 판단해야 합니다'}
                    </span>
                  </div>
                )}
              </div>

              <div className="mt-3">
                <span className="label">국내 유통 동일성</span>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
                  {recall.domestic_check === 'DISTRIBUTED' ? '유통 확인됨'
                    : recall.domestic_check === 'NOT_DISTRIBUTED' ? '유통되지 않음'
                    : recall.domestic_check === 'UNKNOWN' ? '확인 불가'
                    : '미확인 — 담당자 확인이 필요합니다.'}
                  {' '}동일 제품의 국내 유통이 확인되면 제품안전기본법 제13조 제3항의 사업자
                  즉시 보고 의무 대상인지 검토 대상이 됩니다. 이 체계는 유통 여부를 추정하지
                  않습니다.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {!run ? (
        <section className="mt-10 border-t border-rule pt-6">
          <p className="text-[13px] text-ink-2">아직 분석하지 않았습니다.</p>
          <code className="addr mt-2 block text-[12px] text-ink">
            npm run search -- --case {ev.id}
          </code>
        </section>
      ) : (
        <>
          <section className="mt-10 flex flex-wrap items-baseline justify-between gap-2 border-t border-rule pt-5">
            <h2 className="text-[15px] font-semibold">
              관련될 수 있는 조항 {results.length}건 — 확인을 권고합니다
            </h2>
            <div className="addr text-[11px] text-ink-3">
              {[
                run.use_code && '코드',
                run.use_keyword && '어휘',
                run.use_vector && '의미',
                run.use_rerank && '재채점',
              ]
                .filter(Boolean)
                .join(' + ')}
            </div>
          </section>

          {run.use_rerank && run.rerank_model && (
            <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
              재채점에 언어모델을 썼습니다({run.rerank_model}). 저장된 결과는 다시 열어도 같지만,
              같은 조건으로 다시 계산하면 순서가 달라질 수 있습니다.
            </p>
          )}

          {results.length === 0 ? (
            <section className="mt-6 border-t border-rule pt-5">
              <p className="text-[13px] text-ink-2">
                후보가 없습니다. 이것이 곧 &ldquo;기준에 조항이 없다&rdquo;는 뜻은 아닙니다.
              </p>
              <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-ink-3">
                품목·기준이 확정되지 않았거나, 조항이 아직 태깅되지 않았거나, 시험방법 연결이
                없어서일 수 있습니다. 개요 화면에서 준비 상태를 먼저 확인하세요.
              </p>
            </section>
          ) : (
            <>
              {hfUnresolved && (
                <div className="mt-4 border border-caution bg-caution-soft px-4 py-3 text-[12px] leading-relaxed text-caution">
                  <strong className="font-semibold">이 사건은 원인이 확정되지 않았습니다.</strong>
                  <p className="mt-1">
                    조사에서 결함이 확인되지 않았거나 보고서에 원인 서술이 없는 경우입니다.
                    아래 후보는 피해유형·어휘·의미만으로 넓게 건진 것이어서 코드 근거가 없습니다.
                    특정 시험을 단정하지 마시고 직접 검토해 주세요.
                  </p>
                </div>
              )}

              <div className="mt-2">
                {shortlist.map((r) => <Candidate key={r.id} r={r} caseId={ev.id} />)}
              </div>

              {rest.length > 0 && (
                <details className="mt-4 border-t border-rule pt-4">
                  <summary className="cursor-pointer text-[13px] text-ink-2 hover:text-ink">
                    나머지 {rest.length}건 더 보기
                    <span className="ml-2 text-[11px] text-ink-3">
                      감추지 않고 모두 저장돼 있습니다
                    </span>
                  </summary>
                  <div className="mt-1">
                    {rest.map((r) => <Candidate key={r.id} r={r} caseId={ev.id} />)}
                  </div>
                </details>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
