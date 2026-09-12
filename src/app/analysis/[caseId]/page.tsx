import Link from 'next/link';
import { DoneBanner, FlowChart } from '@/components/Panel';
import { ActionForm } from '@/components/ActionForm';
import { getDb } from '@/lib/db';
import { getSignedUrl } from '@/lib/supabase/server';
import { standardsForCase } from '@/lib/cases/resolve-scope';
import { EvidenceStrip, type EvidenceLevel, type MatchPath } from '@/components/EvidenceStrip';
import { PageToc, type TocItem } from '@/components/PageToc';
import type { GpcCandidate } from '@/lib/gpc/lookup';
import type { GpcMatchLevel } from '@/lib/gpc/verify';
import { estimateCauses, type CauseCandidate } from '@/lib/codebook/cause-bridge';
import { standardName, shortTitle } from '@/lib/standards/label';
import { GPC_SOURCE_LABEL, GPC_SOURCE_NOTE, needsReview, type GpcSource } from '@/lib/gpc/provenance';
import { withEstimatedCauses } from '@/lib/search/estimate-cause';
import { searchCandidates, type Candidate as SearchCandidate } from '@/lib/search/match';
import { loadCaseInput, defaultMatchConfig } from '@/lib/search/run';
import { recordReview, runAnalysisAction, setChildProductCheck } from './actions';
import { InvestigationSummary, SecondOpinionFindings } from './SecondOpinion';
import { REJECT_REASONS } from './review-options';

export const dynamic = 'force-dynamic';

/**
 * 화면 D — 사건 분석 (설계문서 §8.4)
 *
 * "판정하지 않는다"의 UI 번역이 이 화면의 전부다.
 *
 *   위반 판정 금지  →  문구를 "관련될 수 있음 / 확인 권고"로 고정, 적색 아이콘 미사용
 *   근거 제시      →  조항 원문·시험 항목·찾은 경로·재채점 이유를 펼쳐 보기로 제공
 *   HITL 확정      →  채택/반려가 기본 동작, 아무것도 안 하면 미확정으로 남는다
 *   폴백 명시      →  코드 없이 찾은 결과는 별도 배지로 구분
 *   누락 방지      →  상위 5건 우선 표시, 나머지는 '더 보기'로 항상 열어 둔다
 *
 * 마지막 항목이 특히 중요하다. 사고조사에서 시험 항목 누락은 되돌릴 수 없는 손실이므로
 * 시스템이 임의로 감추면 안 된다(§5.6.3).
 */

const SHORTLIST = 5;

/** 어린이제품 여부 — 확인하지 않은 것과 아니라고 확인한 것은 다른 상태다(055) */
const CHILD_CHECK_LABEL: Record<string, string> = {
  UNCHECKED: '미확인 — 담당자 확인이 필요합니다',
  CHILD: '어린이제품 (공통안전기준 적용)',
  NOT_CHILD: '어린이제품 아님',
  UNKNOWN: '확인했지만 알아내지 못함',
};

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
  /** 그 기준이 무슨 품목의 기준인가 — 번호만 보고는 알 수 없다 */
  standard_item: string | null;
  has_reviewed_tag: boolean;
  codes: string[] | null;
  test_conditions: string[] | null;
  test_methods: Array<{ marker: string; body: string | null }> | null;
  decision: string | null;
  reject_reason: string | null;
  /** 이 조항이 속한 절의 제목. 절 껍데기 조항에서 끌어온다 */
  section_title: string | null;
}

/**
 * 결과를 절로 묶는다 (04 §7.2)
 *
 * 검색은 이미 절 단위로 돈다(run.ts). 표시만 평평한 채로 남아 있어서, 담당자가
 * "절 15 를 보라"고 읽는 방식과 화면이 어긋나 있었다.
 *
 * 하위 조항을 감추지 않는다 — 실측에서 담당자가 적는 계위가 계열마다 달랐다.
 * 전기용품은 절 단위 64%, 생활·어린이는 조항 단위 94%다. 절을 머리에 두고 그 아래
 * 조항을 펼쳐 두면 한 화면이 둘 다 감당한다.
 */
function groupResults(rows: ResultRow[]): Array<{
  key: string; section: string; title: string | null; standard: string | null; rows: ResultRow[];
}> {
  const out: Array<{ key: string; section: string; title: string | null; standard: string | null; rows: ResultRow[] }> = [];
  const index = new Map<string, number>();
  for (const r of rows) {
    const section = r.marker.includes('.') ? r.marker.slice(0, r.marker.indexOf('.')) : r.marker;
    const key = `${r.standard_name ?? ''}::${section}`;
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push({ key, section, title: r.section_title, standard: r.standard_name, rows: [r] });
    } else {
      out[at].rows.push(r);
    }
  }
  return out;
}

interface CaseEventRow {
  id: number; title: string | null; narrative: string; item_name: string | null;
  source_type: string; occurred_on: string | null; source_file_id: number | null;
  product_scope_id: number | null; scope_evidence: string | null; basis_date: string | null;
  scope_name: string | null;
  child_product_check: string; child_product_note: string | null;
  gpc_brick_code: string | null; gpc_candidates: GpcCandidate[] | null;
  /** 이 코드가 어디서 왔나 (065) — EXPERT · OECD · SOURCE_AI · OUR_AI */
  gpc_source: string | null;
  gpc_verified_level: GpcMatchLevel | null;
  gpc_verified_segment_code: string | null; gpc_verified_segment_title: string | null;
  gpc_verified_family_code: string | null; gpc_verified_family_title: string | null;
  gpc_verified_class_code: string | null; gpc_verified_class_title: string | null;
  gpc_verified_brick_code: string | null; gpc_verified_brick_title: string | null;
  gpc_verification: { confidenceScore: number; reasoning: string } | null;
}

const GPC_LEVEL_LABEL: Record<Exclude<GpcMatchLevel, 'NONE'>, string> = {
  BRICK: 'Brick', CLASS: 'Class', FAMILY: 'Family', SEGMENT: 'Segment',
};

const ANALYSIS_TOC: TocItem[] = [
  { id: 'analysis-case', label: '사건 요약' },
  { id: 'analysis-investigation', label: '보고서가 한 일' },
  { id: 'analysis-scope', label: '품목·적용기준' },
  { id: 'analysis-gpc', label: 'GPC 품목분류' },
  { id: 'analysis-recall', label: '해외 리콜 근거' },
  { id: 'analysis-results', label: '관련될 수 있는 조항' },
  { id: 'analysis-second-opinion', label: '병행 점검 소견' },
];

/** 사고보고서에만 붙는 구역 — 리콜은 원인이 이미 적혀 있어 병행 점검 대상이 아니다 */
const ACCIDENT_TOC_IDS = new Set(['analysis-investigation', 'analysis-second-opinion']);

/** gpc_verified_level 이 가리키는 계층의 코드·제목을 뽑는다 — 계층 아래는 항상 NULL 이다(verify.ts 참고) */
function gpcVerifiedCodeTitle(ev: CaseEventRow): { code: string; title: string | null } | null {
  switch (ev.gpc_verified_level) {
    case 'BRICK': return ev.gpc_verified_brick_code ? { code: ev.gpc_verified_brick_code, title: ev.gpc_verified_brick_title } : null;
    case 'CLASS': return ev.gpc_verified_class_code ? { code: ev.gpc_verified_class_code, title: ev.gpc_verified_class_title } : null;
    case 'FAMILY': return ev.gpc_verified_family_code ? { code: ev.gpc_verified_family_code, title: ev.gpc_verified_family_title } : null;
    case 'SEGMENT': return ev.gpc_verified_segment_code ? { code: ev.gpc_verified_segment_code, title: ev.gpc_verified_segment_title } : null;
    default: return null;
  }
}

function evidenceLevelOf(p: MatchPath, reviewed: boolean): EvidenceLevel {
  if (p === 'FALLBACK') return 'C';
  if ((p === 'CODE' || p === 'CODE-PARTIAL') && reviewed) return 'A';
  return 'B';
}

async function load(caseId: number) {
  const db = getDb();

  const [ev] = await db<CaseEventRow[]>`
    select e.id, e.title, e.narrative, e.item_name, e.source_type, e.occurred_on::text,
           e.source_file_id,
           e.product_scope_id, e.scope_evidence, e.basis_date::text,
           e.child_product_check, e.child_product_note,
           ps.name as scope_name,
           e.gpc_brick_code, e.gpc_candidates, e.gpc_source,
           e.gpc_verified_level,
           e.gpc_verified_segment_code, e.gpc_verified_segment_title,
           e.gpc_verified_family_code, e.gpc_verified_family_title,
           e.gpc_verified_class_code, e.gpc_verified_class_title,
           e.gpc_verified_brick_code, e.gpc_verified_brick_title,
           e.gpc_verification
    from public.case_event e
    left join public.product_scope ps on ps.id = e.product_scope_id
    where e.id = ${caseId}
  `;
  if (!ev) return null;

  /*
    사고사진 (068) — 원본 PDF 는 개인정보 때문에 저장소에 없으므로, 미리 뽑아
    Storage 에 저장해 둔 사진만 보여 준다(process-photos.ts). 버킷이 비공개라
    서명 URL을 서버에서 만들어 넘긴다 — service_role 키는 화면 밖으로 안 나간다.
  */
  const photos = ev.source_file_id
    ? await (async () => {
        const rows = await db<{
          id: number; page_number: number; storage_path: string;
          is_relevant_photo: boolean | null; description: string | null;
          hazard_note: string | null; analyzed_at: string | null;
        }[]>`
          select id, page_number, storage_path, is_relevant_photo, description,
                 hazard_note, analyzed_at::text
          from public.source_file_image
          where source_file_id = ${ev.source_file_id}
          order by page_number
        `;
        return Promise.all(
          rows.map(async (r) => ({
            ...r,
            url: await getSignedUrl(r.storage_path).catch(() => null),
          })),
        );
      })()
    : [];

  // 이 사건에 적용되는 기준. 품목 확정의 결과이자 검색 범위 그 자체다(v0.7 §3.2).
  // 명령줄 분석과 같은 함수를 쓴다 — 화면과 실제 검색 범위가 어긋나면 안 된다.
  const standardIds = await standardsForCase(caseId);
  /*
    번호만으로는 담당자가 알 수 없다 (담당자 지적, 2026-09-09)

    "모든 것들은 안전기준에 있는 품목 명칭을 다 꼭 모두 넣어 주세요(다른 페이지 포함).
     왜냐하면 검토 시 너무 양이 많아 분간이 어렵다." 안전기준 담당자는 품목별로
    나뉘어 있어 자기 품목군 밖의 번호는 읽어도 무엇인지 모른다. 그래서 이 화면도
    번호 옆에 품목명을 함께 싣는다. 이름의 재료는 standard_view 에 모여 있다(057·058).
  */
  const standards = standardIds.length
    ? await db<{
        display_name: string; item_name: string | null; title_ko: string | null;
        items: string[] | null; sub_items: string[] | null; relation: string | null;
      }[]>`
        select s.display_name, s.item_name, s.title_ko, s.items, s.sub_items,
               (select a.relation from public.standard_applicability a
                where a.standard_id = s.id and a.product_scope_id = ${ev.product_scope_id}
                limit 1) as relation
        from public.standard_view s
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
    rerank_status: 'skipped' | 'ok' | 'failed';
    hyde_text: string | null;
  }[]>`
    select id, started_at::text, use_code, use_keyword, use_vector, use_rerank,
           result_count, rerank_model, embedding_model, rerank_status, hyde_text
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
          -- 조항이 어느 품목의 기준인지도 함께 — 번호만으로는 분간이 안 된다(2026-09-09)
          coalesce(s.item_name, s.title_ko) as standard_item,
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
           where rl.match_result_id = r.id order by rl.created_at desc limit 1) as reject_reason,
          /*
            이 조항이 속한 절의 제목 (2026-09-05)

            담당자는 "절 15 를 보라"고 말하는데 화면은 "15.1"만 보여 줬다. 절 번호만으로는
            무슨 시험인지 알 수 없어 조항을 하나씩 열어 봐야 했다. 절 껍데기 조항이
            제목을 갖고 있으므로(IEC 계열에서 절은 제목만 있는 껍데기다) 그것을 끌어온다.

            같은 부(part)의 절을 골라야 한다 — 실측으로 걸러 낸 함정이다.
            KC 60335-1 에는 marker='11' 인 조항이 본문·부속서 B·E·H·P·S 로 여섯 개 있고,
            본문에서는 "온도 상승"이지만 부속서 E 에서는 "시험 결과의 평가"다. 부를 맞추지
            않고 본문 길이로 골랐더니 온도 상승 조항에 엉뚱한 제목이 붙었다.
          */
          (select coalesce(nullif(trim(sec.title_raw), ''), nullif(trim(sec.body), ''))
             from public.clause sec
            where sec.standard_id = c.standard_id
              and sec.marker = split_part(c.marker, '.', 1)
              and sec.part is not distinct from c.part
            -- 제목이 있는 것을 먼저, 그다음 본문이 짧은 것(껍데기가 곧 제목이다)
            order by (sec.title_raw is null), length(coalesce(sec.body, ''))
            limit 1) as section_title
        from public.match_result r
        join public.clause c   on c.id = r.clause_id
        join public.standard s on s.id = c.standard_id
        where r.run_id = ${run.id}
        order by r.final_rank
      `
    : [];

  return { ev, tags, run, results, standards, recall, photos };
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
          <span className="text-[12px] text-ink-3">
            {r.standard_item && (
              <span className="text-ink-2">{shortTitle(r.standard_item) ?? r.standard_item} </span>
            )}
            <span className="addr">{r.standard_name}</span>
          </span>
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
        /*
          시험방법도 접는다 (담당자 요청).

          다만 조항번호는 항상 보인다 — 담당자가 이 화면에서 얻어야 하는 결론이
          "몇 조 시험을 의뢰할 것인가"이기 때문이다. 그 답은 번호이고, 본문은
          번호를 확인하고 싶을 때만 필요하다.
        */
        <div className="mt-3 border-l-2 border-measure bg-measure-soft/40 px-3 py-2">
          <div className="label text-measure">시험방법</div>
          {r.test_methods.map((tm, i) => (
            <div key={i} className="mt-1 text-[12px] leading-snug">
              {tm.body ? (
                <details>
                  <summary className="cursor-pointer">
                    <span className="addr font-medium">{tm.marker}</span>
                    <span className="ml-2 text-ink-3 hover:text-ink">내용 보기</span>
                  </summary>
                  <p className="mt-1 leading-relaxed text-ink-2">{tm.body}</p>
                </details>
              ) : (
                <>
                  <span className="addr font-medium">{tm.marker}</span>
                  <span className="ml-2 text-ink-2">
                    이 기준에 없습니다 — 다른 기준을 참조합니다
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-[12px] text-caution">
          시험방법 연결이 없습니다. 관련 조항은 찾았지만 어떤 시험을 의뢰해야 하는지까지는 알려 드리지 못합니다.
        </div>
      )}

      {r.test_conditions?.length ? (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink">
            시험 항목·허용치 {r.test_conditions.length}건 보기
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

/**
 * 원인 후보 고르기 — 원인이 미상인 사건에서만 나온다 (04-1 §7)
 *
 * 기본 목록을 덮어쓰지 않는 것이 핵심이다. 실측에서 추정 원인을 기본 검색에 자동으로
 * 섞었더니 정답셋 47건 평균 재현율이 16.2% → 14.6% 로 떨어졌다. 잘 찾고 있던 8건이
 * 나빠졌기 때문이다. 반대로 아무것도 못 찾던 23건 중 5건은 이 경로로만 답이 나왔다.
 *
 * 그래서 자동으로 켜지 않고, 담당자가 고른 원인으로 **두 번째 목록**을 따로 만든다.
 * 주소에 실어 두므로(?cause=…) 같은 화면을 다시 열거나 남에게 보내도 그대로 나온다.
 */
function CausePicker({
  caseId, candidates, picked,
}: { caseId: number; candidates: CauseCandidate[]; picked: string[] }) {
  return (
    <form method="get" action={`/analysis/${caseId}`} className="mt-4 border border-rule px-4 py-3.5">
      <div className="label">원인 후보 — 같은 피해가 난 다른 사건에서는 무엇이 원인이었나</div>
      <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-ink-3">
        해외 리콜 자료에서 같은 피해가 난 사건의 원인을 세어 본 것입니다. 이 사건의 원인이라는
        뜻이 아니라 <strong className="font-semibold">확인해 볼 만한 후보</strong>입니다.
        품목을 아는 담당자만 이 중 무엇이 그럴듯한지 가릴 수 있습니다.
      </p>
      {/*
        분모와 출처를 반드시 적는다 (담당자 지적, 2026-09-05)

        "과열 59%" 만 적으면 "이 사건이 과열일 확률 59%" 로 읽힌다. 전혀 다른 뜻이다 —
        해외 리콜이라는 **다른 자료**에서 관찰된 비율이고 이 사건과는 무관하게 계산됐다.
        게다가 한 사건에 원인 코드가 여러 개 붙어 비율의 합이 100%를 넘는다(59+39+25+13).
        나눠 가진 몫처럼 읽히면 안 되므로 분모를 줄마다 그대로 적는다.
      */}
      <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-ink-3">
        비율은 <strong className="font-semibold">해외 리콜에서 같은 피해가 난 사건 중</strong> 이
        원인이 함께 적힌 비율입니다. 이 사건이 그 원인일 확률이 아닙니다. 한 사건에 원인이
        여럿 붙을 수 있어 비율을 다 더하면 100%를 넘습니다.
      </p>

      <div className="mt-3">
        {candidates.map((c) => (
          <label key={c.hfCode} className="flex cursor-pointer items-baseline gap-2.5 border-t border-rule py-2">
            <input
              type="checkbox" name="cause" value={c.hfCode}
              defaultChecked={picked.includes(c.hfCode)}
              className="mt-0.5"
            />
            <span className="text-[13px] font-medium">{c.nameKo ?? c.hfCode}</span>
            <span className="addr text-[10px] text-ink-3">{c.hfCode}</span>
            <span className="ml-auto text-[11px] text-ink-3">
              해외 리콜 {c.sampleSize.toLocaleString()}건 중{' '}
              <span className="addr">{c.support.toLocaleString()}</span>건에 함께 적힘
              <span className="addr ml-2">({(c.confidence * 100).toFixed(0)}%)</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft">
          고른 원인으로 시험항목 찾기
        </button>
        {picked.length > 0 && (
          <Link href={`/analysis/${caseId}`} className="text-[12px] text-ink-3 underline">
            지우기
          </Link>
        )}
        <span className="text-[11px] text-ink-3">위의 기본 목록은 그대로 둡니다</span>
      </div>
    </form>
  );
}

/** 원인으로 찾은 조항 — 저장하지 않는다. 담당자가 지금 보려고 만든 목록이다 */
function CauseResult({ c }: { c: SearchCandidate }) {
  return (
    <article className="border-t border-rule py-4">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <span className="addr text-[15px] font-medium">{c.marker}</span>
        <span className="text-[12px] text-ink-3">{c.standardName}</span>
        <span className="addr ml-auto text-[11px] text-ink-3">{c.score.toFixed(4)}</span>
      </div>
      {c.breadcrumbPath && (
        <div className="addr mt-2 text-[11px] text-ink-3">{c.breadcrumbPath}</div>
      )}
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-ink-2">{c.body}</p>
      {c.testMethods.length > 0 && (
        <p className="mt-2 max-w-3xl text-[12px] text-ink-3">
          시험방법 {c.testMethods.map((t) => t.marker).join(' · ')}
        </p>
      )}
    </article>
  );
}

/** 절 하나와 그 아래 걸린 조항들 */
function SectionBlock({
  group, caseId,
}: {
  group: { section: string; title: string | null; standard: string | null; rows: ResultRow[] };
  caseId: number;
}) {
  // 절 제목이 본문에서 온 경우 문장 전체가 올 수 있어 앞머리만 쓴다
  const title = group.title?.replace(/\s+/g, ' ').trim().slice(0, 60) ?? null;

  return (
    <section className="mt-4 border-t-2 border-rule pt-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[14px] font-semibold">
          절 <span className="addr">{group.section}</span>
          {title && <span className="ml-2 font-medium">{title}</span>}
        </h3>
        <span className="text-[11px] text-ink-3">{group.standard}</span>
        <span className="ml-auto text-[11px] text-ink-3">조항 {group.rows.length}건</span>
      </div>
      <div className="pl-3">
        {group.rows.map((r) => <Candidate key={r.id} r={r} caseId={caseId} />)}
      </div>
    </section>
  );
}

export default async function AnalysisPage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ done?: string; cause?: string | string[] }>;
}) {
  const { caseId: raw } = await params;
  const { done, cause } = await searchParams;
  const caseId = Number(raw);
  const picked = (Array.isArray(cause) ? cause : cause ? [cause] : []).filter(Boolean);

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

  const { ev, tags, run, results, standards, recall, photos } = data;
  const shortlist = results.slice(0, SHORTLIST);
  const rest = results.slice(SHORTLIST);
  const hfUnresolved = tags.length > 0
    && causeUnresolved(tags.filter((t) => t.axis === 'HF').map((t) => t.code));

  /*
    원인 후보와, 담당자가 고른 원인으로 찾은 두 번째 목록.

    화면을 그릴 때 검색을 한 번 더 도는 것이라 저장하지 않는다. 기록으로 남길 것은
    담당자가 채택·반려한 판단이지, 목록을 펼쳐 본 사실이 아니다. 리랭킹도 끈다 —
    LLM 을 부르면 화면이 느려지고, 여기서 필요한 것은 순서 다듬기가 아니라
    "원인으로 찾으면 무엇이 나오는가"이다.
  */
  let causeCandidates: CauseCandidate[] = [];
  let causeResults: SearchCandidate[] = [];
  if (hfUnresolved) {
    try {
      const dtCodes = tags.filter((t) => t.axis === 'DT').map((t) => t.code);
      causeCandidates = await estimateCauses(dtCodes, { limit: 8 });
      if (picked.length > 0) {
        const input = await loadCaseInput(ev.id);
        const est = await withEstimatedCauses(input, { picked });
        if (est.candidates.length > 0) {
          causeResults = await searchCandidates(est.input, defaultMatchConfig({ useRerank: false }));
        }
      }
    } catch (e) {
      // 원인 후보를 못 만들어도 기본 목록은 그대로 보여 준다. 곁가지가 본 줄기를 막지 않는다
      console.error(`원인 후보 조회 실패 (사건 ${ev.id}):`, e);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_10rem]">
      <div>
      <DoneBanner message={done} />
      <header id="analysis-case" className="mt-6 scroll-mt-8">
        {/* 사건번호는 뺐다(담당자 요청) — 내부 식별자일 뿐 담당자가 쓸 일이 없다 */}
        <div className="label">
          {ev.source_type === 'ACCIDENT' ? '사고보고서' : '리콜'}
          {ev.occurred_on && ` · ${ev.occurred_on}`}
        </div>
        <h1 className="mt-2 max-w-2xl text-[24px] leading-snug font-semibold tracking-tight">
          {ev.title ?? ev.narrative.slice(0, 60)}
        </h1>
        {/*
          이 화면의 일 순서를 다른 화면과 같은 모양의 순서도로 (담당자 요청, 2026-09-09)
          원본은 docs/전체_프로세스와_용어.md §3 의 C1~D1 구간이다.
        */}
        <FlowChart
          steps={[
            { label: '사건 내용', href: '#analysis-case', state: 'done' },
            {
              label: '품목·기준 확정',
              href: '#analysis-scope',
              note: standards.length > 0 ? `기준 ${standards.length}종` : '미확정 — 여기서 멈춤',
              state: standards.length > 0 ? 'done' : 'here',
            },
            {
              label: '조항 후보 찾기',
              href: '#analysis-results',
              note: run ? `${results.length}건` : '아직 실행 안 함',
              state: run ? 'done' : 'here',
            },
            {
              label: '채택·반려',
              who: '사람',
              note: `${results.filter((r) => r.decision != null).length} / ${results.length}`,
              state: 'here',
            },
            { label: '산출물', href: '/insights', note: '시험항목·개선요인', state: 'todo' },
          ]}
        />
        {/*
          원문을 접어 둔다 (담당자 요청: "사고보고서 분석 페이지가 너무 길어요")

          사고조사보고서는 PDF 에서 뽑은 글자를 통째로 담고 있어 한 건이 수천 자다.
          그것을 펼쳐 두면 정작 봐야 할 「관련될 수 있는 조항」이 화면 한참 아래로
          밀린다. 첫 두 줄만 보이고 필요할 때 펼치게 한다 —
          원문 확인은 등록 단계에서 이미 한 번 하는 일이다.
        */}
        <details className="mt-3 max-w-2xl">
          <summary className="cursor-pointer list-none">
            <span className="block text-[13px] leading-relaxed text-ink-2">
              {ev.narrative.slice(0, 160)}
              {ev.narrative.length > 160 && '…'}
            </span>
            <span className="mt-1 inline-block text-[11px] text-ink-3 hover:text-ink">
              사고보고서 원문 전체 보기 ({ev.narrative.length.toLocaleString()}자)
            </span>
          </summary>
          <p className="mt-2 border-l-2 border-rule pl-3 text-[12px] leading-relaxed whitespace-pre-line text-ink-2">
            {ev.narrative}
          </p>
        </details>

        {/*
          사고사진 (068) — 텍스트만으로는 원인을 못 찾은 사건에서 실제로 단서가
          여기 있었다(실측: 전기방석 사건, 텍스트는 "시험 적합"뿐이었지만 사진에는
          전선 피복 손상이 보였다). 아직 비전 분석 전이면(analyzed_at null)
          "분석 대기"만 표시한다 — /ops 에서 켜야 도는 배치 작업이다.
        */}
        {photos.length > 0 && (
          <details className="mt-3 max-w-2xl">
            <summary className="cursor-pointer list-none text-[11px] text-ink-3 hover:text-ink">
              첨부 사진 {photos.length}장 보기
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {photos.map((p) => (
                <div key={p.id} className="border border-rule-soft p-2">
                  {p.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 서명 URL은 매 렌더 새로 발급돼 next/image 캐시와 안 맞는다
                    <img src={p.url} alt={`${p.page_number}쪽 사진`} className="w-full object-contain" />
                  ) : (
                    <div className="flex h-24 items-center justify-center text-[11px] text-ink-3">
                      이미지를 불러오지 못했습니다
                    </div>
                  )}
                  <div className="mt-1.5 text-[11px] text-ink-3">{p.page_number}쪽</div>
                  {p.analyzed_at ? (
                    <>
                      {p.is_relevant_photo === false && (
                        <div className="text-[11px] text-ink-3">장식·서식 이미지로 판정됨</div>
                      )}
                      {p.description && (
                        <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{p.description}</p>
                      )}
                      {p.hazard_note && (
                        <p className="mt-1 text-[11px] leading-relaxed text-caution">⚠ {p.hazard_note}</p>
                      )}
                    </>
                  ) : (
                    <div className="mt-1 text-[11px] text-ink-3">분석 대기 중</div>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="label mr-1">붙은 코드</span>
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

      {/*
        보고서가 한 일 (070) — 사고보고서에만 붙는다.

        사건 요약 바로 아래에 두는 이유: 담당자가 "이 보고서가 무엇을 했는지"를
        먼저 봐야 그 아래 목록들의 성격을 읽을 수 있다. 「적합」이라는 결론도
        시험한 범위 안에서만 적합이라는 것이 이 구역에서 드러난다.
      */}
      {ev.source_type === 'ACCIDENT' && <InvestigationSummary caseId={ev.id} />}

      {/* 품목·적용기준 — 검색보다 먼저 결정되는 것이므로 후보 목록보다 위에 둔다 */}
      <section id="analysis-scope" className="mt-6 scroll-mt-8 border-t border-rule pt-5">
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
                    {standards.map((s) => {
                      const { name } = standardName(s);
                      return (
                        <span key={s.display_name} className="border border-rule px-1.5 py-0.5 text-[11px] text-ink-2">
                          {name && <span className="mr-1">{name}</span>}
                          <span className="addr text-ink-3">{s.display_name}</span>
                          {s.relation && <span className="ml-1 text-ink-3">{s.relation === 'ANNEX' ? '부속서' : '공통'}</span>}
                        </span>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <div className="border border-caution bg-caution-soft px-3 py-2 text-[12px] leading-relaxed text-caution">
                <strong className="font-semibold">품목 미확정 (SCOPE_UNRESOLVED)</strong>
                <p className="mt-1">
                  적용 기준 미확정 — 분석 미실행 (전 품목 검색 시 다른 제품 시험 혼입).
                  품목 등록 후 재실행.
                </p>
              </div>
            )}

            {/*
              어린이제품인가 — 사람이 정하고, 정하면 적용 기준이 바뀐다 (055)

              가이드라인의 결정요소(사용연령 표시·포장 문구·판매 구역 …)는 실물을 봐야
              판정된다. 그래서 시스템은 추정하지 않고 받아 적는다. 확정하면 어린이제품
              공통안전기준이 적용 기준에 들어가고(유해원소·프탈레이트·자석·작은 부품),
              아니라고 하면 자동 판정이 붙였더라도 뺀다.
            */}
            <div className="mt-4 border border-rule-soft px-3 py-2.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="label">어린이제품 여부</span>
                <span className={`text-[12px] font-medium ${
                  ev.child_product_check === 'CHILD' ? 'text-measure'
                  : ev.child_product_check === 'NOT_CHILD' ? 'text-ink-2'
                  : 'text-caution'}`}
                >
                  {CHILD_CHECK_LABEL[ev.child_product_check] ?? '미확인'}
                </span>
              </div>

              {ev.child_product_note && (
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                  근거: {ev.child_product_note}
                </p>
              )}

              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
                만 13세 이하 어린이가 쓰거나 어린이를 위해 쓰는 물품이면 어린이제품입니다.
                포장·광고·사용연령 표시·판매 구역을 보고 정합니다(「어린이제품 가이드라인」 고시).
                <strong className="font-semibold"> 어린이제품으로 정하면 공통안전기준이 적용 기준에 들어갑니다</strong> —
                유해원소·프탈레이트·자석·작은 부품은 부속서가 아니라 그 기준에만 있습니다.
              </p>

              <form action={setChildProductCheck} className="mt-2.5 flex flex-wrap items-center gap-2">
                <input type="hidden" name="caseId" value={caseId} />
                <input
                  name="note"
                  defaultValue={ev.child_product_note ?? ''}
                  placeholder="무엇을 보고 정했는지 — 예: 포장에 '3세 이상' 표시"
                  className="min-w-[16rem] flex-1 border border-rule bg-surface px-2 py-1.5 text-[12px]"
                />
                <button
                  type="submit" name="value" value="CHILD"
                  className="border border-measure bg-measure px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-85"
                >
                  어린이제품
                </button>
                <button
                  type="submit" name="value" value="NOT_CHILD"
                  className="border border-rule px-3 py-1.5 text-[12px] text-ink-2 hover:bg-measure-soft"
                >
                  아님
                </button>
                <button
                  type="submit" name="value" value="UNKNOWN"
                  className="border border-rule px-3 py-1.5 text-[12px] text-ink-2 hover:bg-measure-soft"
                >
                  알 수 없음
                </button>
                {ev.child_product_check !== 'UNCHECKED' && (
                  <button
                    type="submit" name="value" value="UNCHECKED"
                    className="px-2 py-1.5 text-[11px] text-ink-3 underline underline-offset-2 hover:text-measure"
                  >
                    확인 취소
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>
      </section>

      {/* GPC(GS1 국제 품목분류) 후보 — 사고사진 비전 분석에서 뽑은 제품 서술로 조회한 것.
          라운드 12부터 standard 와 같은 방식(findAndVerifyGpc)으로 LLM 1차 검증을 거친다.
          검증됐어도 확정으로 단정하지 않는다 — 이 화면의 "판정하지 않는다" 원칙은 그대로다. */}
      {ev.gpc_candidates && ev.gpc_candidates.length > 0 && (() => {
        const verified = gpcVerifiedCodeTitle(ev);
        return (
          <section id="analysis-gpc" className="mt-4 scroll-mt-8 border-t border-rule pt-5">
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <span className="label">GPC 품목분류 후보</span>
              <div className="text-[13px] leading-relaxed">
                {/*
                  코드가 어디서 왔는지 먼저 밝힌다 (065, 담당자 지적)

                  "OECD 포털이 보내는 코드는 각 나라들이 등록할 때 사용하는 코드로
                  신빙성이 매우 높습니다." 등록국이 신고한 코드와 우리 AI 가 짐작한
                  코드를 같은 얼굴로 보여 주면 담당자가 무엇을 확인해야 하는지 알 수 없다.
                */}
                {ev.gpc_brick_code && ev.gpc_source && (
                  <div
                    className={`mb-3 border px-3 py-2 text-[12px] leading-relaxed ${
                      needsReview(ev.gpc_source)
                        ? 'border-rule-soft text-ink-2'
                        : 'border-measure bg-measure-soft text-ink-2'
                    }`}
                  >
                    <span className="addr text-ink">{ev.gpc_brick_code}</span>
                    <span className="ml-2 font-medium">
                      {GPC_SOURCE_LABEL[ev.gpc_source as GpcSource] ?? ev.gpc_source}
                    </span>
                    <p className="mt-1 text-ink-3">
                      {GPC_SOURCE_NOTE[ev.gpc_source as GpcSource] ?? ''}
                    </p>
                  </div>
                )}
                {ev.gpc_verified_level == null ? (
                  <p className="text-[12px] text-caution">
                    AI 검증 전 자료입니다(뜻이 비슷한 순서만 있음) — 순위 전체를 참고해 사람이
                    확인하세요.
                  </p>
                ) : ev.gpc_verified_level === 'NONE' ? (
                  <div className="border border-caution bg-caution-soft px-3 py-2 text-[12px] leading-relaxed text-caution">
                    <strong className="font-semibold">LLM 검증: 맞는 후보 없음</strong>
                    <p className="mt-1">확실히 일치하는 코드 없음 — 담당자 확인 필요.</p>
                    {ev.gpc_verification?.reasoning && (
                      <p className="mt-1 text-ink-2">{ev.gpc_verification.reasoning}</p>
                    )}
                  </div>
                ) : (
                  <div className="border border-measure bg-measure-soft/40 px-3 py-2 text-[12px] leading-relaxed">
                    <strong className="font-semibold text-measure">
                      LLM 검증({GPC_LEVEL_LABEL[ev.gpc_verified_level]})
                    </strong>{' '}
                    <span className="addr">{verified?.code}</span> {verified?.title}
                    {ev.gpc_verification && ` · 확신 ${ev.gpc_verification.confidenceScore}`}
                    {ev.gpc_verified_level !== 'BRICK' && (
                      <span className="ml-1 text-ink-3">
                        (정확한 Brick은 후보에 없어 상위 계층까지만 확인됨)
                      </span>
                    )}
                    {ev.gpc_verification?.reasoning && (
                      <p className="mt-1 text-ink-2">{ev.gpc_verification.reasoning}</p>
                    )}
                  </div>
                )}
                <p className="mt-2 text-[12px] text-ink-3">
                  아래 순위는 LLM이 1차 검증한 결과를 포함합니다. 최종 판단은 담당자가 합니다.
                </p>
                <ul className="mt-2 space-y-1">
                  {ev.gpc_candidates.map((c) => {
                    const isVerifiedBrick =
                      ev.gpc_verified_level === 'BRICK' && c.brickCode === ev.gpc_verified_brick_code;
                    const isEmbeddingTop1 = c.brickCode === ev.gpc_brick_code;
                    return (
                      <li
                        key={c.rank}
                        className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 py-1 text-[12px] ${
                          isVerifiedBrick
                            ? 'border border-measure text-measure'
                            : isEmbeddingTop1
                              ? 'border border-rule text-ink-2'
                              : 'text-ink-2'
                        }`}
                      >
                        <span className="addr tnum text-ink-3">{c.rank}위</span>
                        <span className="addr">{c.brickCode}</span>
                        <span className="font-medium">{c.brickTitle}</span>
                        {isVerifiedBrick && (
                          <span className="text-[10px] font-medium text-measure">검증 확정</span>
                        )}
                        {isEmbeddingTop1 && !isVerifiedBrick && (
                          <span className="text-[10px] text-ink-3">유사도 1위</span>
                        )}
                        <span className="text-ink-3">
                          {c.segmentTitle} &gt; {c.familyTitle} &gt; {c.classTitle}
                        </span>
                        <span className="addr tnum ml-auto text-ink-3">{c.similarity.toFixed(3)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </section>
        );
      })()}

      {/* 트랙 B — 해외 리콜에만 있는 것들 */}
      {recall && (
        <section id="analysis-recall" className="mt-4 scroll-mt-8 border-t border-rule pt-5">
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
                <span className="label">리콜한 나라가 든 근거</span>
                {recall.cited_standards.length === 0 ? (
                  <p className="mt-1 text-[12px] text-ink-2">
                    공고에 어떤 표준을 위반했는지 적혀 있지 않습니다. 해외 리콜 열에 일곱은
                    이렇습니다. 그래서 우리 기준과 견줘 볼 수가 없습니다.
                  </p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {recall.cited_standards.map((s) => (
                      <span key={s} className="addr border border-rule px-1.5 py-0.5 text-[11px] text-ink-2">{s}</span>
                    ))}
                    <span className="text-[11px] text-ink-3">
                      {recall.matched_standard_ids.length > 0
                        ? `· 우리 기준 ${recall.matched_standard_ids.length}건과 번호가 같습니다`
                        : '· 우리 기준과 번호 매기는 방식이 달라 사람이 봐야 합니다'}
                    </span>
                  </div>
                )}
              </div>

              <div className="mt-3">
                <span className="label">국내에도 풀렸는가</span>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
                  {recall.domestic_check === 'DISTRIBUTED' ? '국내에도 풀린 것으로 확인됐습니다.'
                    : recall.domestic_check === 'NOT_DISTRIBUTED' ? '국내에는 풀리지 않았습니다.'
                    : recall.domestic_check === 'UNKNOWN' ? '확인했지만 알아내지 못했습니다.'
                    : '아직 확인하지 않았습니다. 담당자가 직접 확인해 주셔야 합니다.'}
                  {' '}같은 제품이 국내에도 풀린 것으로 확인되면, 「제품안전기본법」 제13조
                  제3항에 따라 사업자가 곧바로 보고해야 하는지 따져 봐야 합니다.
                  이 시스템은 국내에 풀렸는지를 스스로 짐작하지 않습니다.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {!run ? (
        <section id="analysis-results" className="mt-10 scroll-mt-8 border-t border-rule pt-6">
          <p className="text-[13px] text-ink-2">아직 분석하지 않았습니다.</p>
          <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-ink-3">
            이 사건에 붙은 위해요인 코드와 사고 내용으로 관련될 만한 안전기준 조항을 찾습니다.
            몇 초 걸립니다.
          </p>
          <div className="mt-3">
            <ActionForm
              action={runAnalysisAction}
              hidden={{ caseId: ev.id }}
              label="분석 실행"
              pendingLabel="분석하는 중…"
              className="border border-measure bg-measure px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
              messageClassName="text-[12px] leading-relaxed text-ink-2"
            />
          </div>
        </section>
      ) : (
        <>
          <section id="analysis-results" className="mt-10 flex scroll-mt-8 flex-wrap items-baseline justify-between gap-2 border-t border-rule pt-5">
            <h2 className="text-[15px] font-semibold">
              관련될 수 있는 조항 {results.length}건 — 확인해 보시기를 권합니다
            </h2>
            <div className="addr text-[11px] text-ink-3">
              {[
                run.use_code && '코드',
                run.use_keyword && '어휘',
                run.use_vector && '의미',
                // 재채점을 켰지만 실패한 실행은 "재채점"이라고 적지 않는다.
                // 순서가 다시 매겨진 것처럼 보이면 담당자가 그 순서를 근거로 읽는다(031)
                run.use_rerank && (run.rerank_status === 'ok' ? '재채점' : '재채점 안 됨'),
              ]
                .filter(Boolean)
                .join(' + ')}
            </div>
          </section>

          {run.rerank_status === 'ok' && run.rerank_model && (
            <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
              순서를 다시 매길 때 AI 를 썼습니다({run.rerank_model}). 저장된 결과는 다시 열어도 그대로지만,
              같은 조건으로 다시 돌리면 순서가 달라질 수 있습니다.
            </p>
          )}

          {/*
            AI 가 지어낸 검색용 문장(HyDE)을 보여 준다 (2026-09-08)

            051 부터 match_run.hyde_text 에 저장은 했지만 화면에는 내보내지 않았다.
            이 문단이 **어떤 조항이 후보로 떠오르는지를 바꾸기** 때문에(재현율
            23.8% → 25.2%), 담당자가 "왜 이 조항이 나왔지"를 되짚을 때 이 단계가
            빈칸이면 경로를 절반만 보는 셈이다.

            다만 그 문단은 기준 원문이 아니다. 그대로 펼쳐 두면 실제 조항으로
            오해하므로 접어 두고, 열기 전에 무엇인지부터 밝힌다.
          */}
          {run.hyde_text && (
            <details className="mt-2 border border-rule-soft px-3 py-2">
              <summary className="cursor-pointer text-[11px] text-ink-3">
                🤖 검색에 쓴 「가상 조항」 보기 — AI가 지어낸 문장입니다 (기준 원문 아님)
              </summary>
              <p className="mt-2 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">
                {run.hyde_text}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                사고 서술만으로는 기준의 문체와 어휘가 달라 의미 검색이 빗나갑니다. 그래서
                「답에 해당할 법한 조항」을 AI에게 지어내게 해 그 문장으로 검색합니다. 위 문장은
                <strong className="font-semibold"> 실제 안전기준에 존재하지 않습니다.</strong> 검색이
                왜 이 방향으로 갔는지를 되짚는 용도이며, 근거로 인용해서는 안 됩니다.
              </p>
            </details>
          )}

          {/*
            재채점이 실패한 실행 — 침묵하면 안 되는 자리다 (031)

            전에는 리랭커가 죽어도 점수 칸이 그냥 비어 있었다. 그런데 빈 점수는
            "AI 가 관련성을 낮게 봤다"로도 읽힌다. 담당자가 그 오해 위에서 조항을
            반려하면, 아무도 채점하지 않은 결과가 반려 근거로 기록에 남는다.
          */}
          {run.rerank_status === 'failed' && (
            <p className="mt-2 border border-caution bg-caution-soft px-3 py-2 text-[11px] leading-relaxed text-caution">
              재채점 실패 — 아래 목록은 검색 점수 순서 그대로, 재채점 점수 공란
              (관련성 낮음이 아니라 채점 실패). 재실행 시 재채점 재시도.
            </p>
          )}


            {causeCandidates.length > 0 && (
              <CausePicker caseId={ev.id} candidates={causeCandidates} picked={picked} />
            )}

            {picked.length > 0 && (
              <section className="mt-5 border border-measure px-4 py-3.5">
                <div className="label text-measure">원인으로 찾은 조항</div>
                <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-ink-3">
                  고르신 원인{' '}
                  <strong className="font-semibold">
                    {causeCandidates.filter((c) => picked.includes(c.hfCode))
                      .map((c) => c.nameKo ?? c.hfCode).join(' · ') || picked.join(' · ')}
                  </strong>
                  을 확인할 수 있는 조항입니다. 아래 기본 목록과 성격이 다릅니다 — 기본 목록은
                  <strong className="font-semibold"> 피해유형을 다루는 조항</strong>이고,
                  이것은 <strong className="font-semibold">원인 가설을 확인할 시험</strong>입니다.
                </p>
                <p className="mt-1.5 text-[11px] text-ink-3">
                  이 목록은 저장되지 않습니다. 채택·반려 기록은 아래 기본 목록에서 남겨 주세요.
                </p>

                {causeResults.length === 0 ? (
                  <p className="mt-3 text-[13px] text-ink-2">
                    고르신 원인으로는 조항을 찾지 못했습니다. 이 기준에 그 원인의 코드가 붙은
                    조항이 아직 없을 수 있습니다.
                  </p>
                ) : (
                  <div className="mt-2">
                    {causeResults.slice(0, SHORTLIST).map((c) => (
                      <CauseResult key={c.clauseId} c={c} />
                    ))}
                    {causeResults.length > SHORTLIST && (
                      <details className="mt-3 border-t border-rule pt-3">
                        <summary className="cursor-pointer text-[13px] text-ink-2 hover:text-ink">
                          나머지 {causeResults.length - SHORTLIST}건 더 보기
                        </summary>
                        <div className="mt-1">
                          {causeResults.slice(SHORTLIST).map((c) => (
                            <CauseResult key={c.clauseId} c={c} />
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </section>
            )}

            {/*
              내려받기 — 담당자가 화면 다음에 하는 일은 시험 의뢰서를 쓰는 것이다.
              조항 번호를 손으로 옮겨 적게 두면 틀리고, 근거도 함께 사라진다.
              주소에 실린 원인 선택을 그대로 넘겨 화면과 파일이 어긋나지 않게 한다.
            */}
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-rule pt-4">
              <a
                href={`/api/analysis/${ev.id}/export${picked.map((c, i) => `${i === 0 ? '?' : '&'}cause=${encodeURIComponent(c)}`).join('')}`}
                className="inline-block border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft"
              >
                CSV 내려받기
              </a>
              <span className="text-[11px] text-ink-3">
                조항 번호·본문·근거·담당자 판단이 함께 나옵니다
                {picked.length > 0 && ' (원인으로 찾은 목록 포함)'}
              </span>
            </div>

          {results.length === 0 ? (
            <section className="mt-6 border-t border-rule pt-5">
              <p className="text-[13px] text-ink-2">
                후보 0건 — &ldquo;기준에 조항 없음&rdquo;을 뜻하지 않음.
              </p>
              <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-ink-3">
                가능한 원인: 품목·기준 미확정 / 조항에 위해요인 코드 미부여 / 시험방법 연결 없음.
                개요 화면에서 준비 상태 먼저 확인.
              </p>
            </section>
          ) : (
            <>
              {hfUnresolved && (
                <div className="mt-4 border border-caution bg-caution-soft px-4 py-3 text-[12px] leading-relaxed text-caution">
                  <strong className="font-semibold">원인 미확정</strong>
                  <p className="mt-1">
                    결함 미확인 또는 보고서에 원인 서술 없음 — 아래 후보는 피해유형·어휘·의미로만
                    넓게 건진 것, 코드 근거 없음. 특정 시험 단정 금지, 직접 검토 필요.
                  </p>
                </div>
              )}

              <div className="mt-2">
                {groupResults(shortlist).map((g) => (
                  <SectionBlock key={g.key} group={g} caseId={ev.id} />
                ))}
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
                    {groupResults(rest).map((g) => (
                      <SectionBlock key={g.key} group={g} caseId={ev.id} />
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </>
      )}

      {/*
        병행 점검 소견 (070) — 기본 조항 목록 **아래**에 둔다.

        위에 두면 기본 목록을 덮어쓰는 것처럼 읽힌다. 04-1 §8 의 실측이 그 반대를
        말한다 — 원인 다리를 기본 검색에 자동 반영했더니 재현율이 16.2%→13.1% 로
        떨어졌고, 결론은 "자동으로 켜지 말고 담당자 손에 쥐여 줘라" 였다.
      */}
      {ev.source_type === 'ACCIDENT' && <SecondOpinionFindings caseId={ev.id} />}
      </div>
      <PageToc items={ANALYSIS_TOC.filter(
        (t) => ev.source_type === 'ACCIDENT' || !ACCIDENT_TOC_IDS.has(t.id),
      )} />
      </div>
    </div>
  );
}
