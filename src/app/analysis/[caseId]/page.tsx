import Link from 'next/link';
import { getDb } from '@/lib/db';
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
  }[]>`
    select id, title, narrative, item_name, source_type, occurred_on::text
    from public.case_event where id = ${caseId}
  `;
  if (!ev) return null;

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

  return { ev, tags, run, results };
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

  const { ev, tags, run, results } = data;
  const shortlist = results.slice(0, SHORTLIST);
  const rest = results.slice(SHORTLIST);

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
