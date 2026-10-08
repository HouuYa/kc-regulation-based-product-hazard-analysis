import Link from 'next/link';
import { DoneBanner } from '@/components/Panel';
import { ActionForm } from '@/components/ActionForm';
import { EvidenceStrip, type EvidenceLevel, type MatchPath } from '@/components/EvidenceStrip';
import { PageToc, type TocItem } from '@/components/PageToc';
import { estimateCauses, type CauseCandidate } from '@/lib/codebook/cause-bridge';
import { shortTitle } from '@/lib/standards/label';
import { withEstimatedCauses } from '@/lib/search/estimate-cause';
import { searchCandidates, type Candidate as SearchCandidate } from '@/lib/search/match';
import { loadCaseInput, defaultMatchConfig } from '@/lib/search/run';
import { ReviewShortcuts } from '@/components/ReviewShortcuts';
import { getDb } from '@/lib/db';
import { recordReview, runAnalysisAction } from './actions';
import { CausePickerSubmit } from './CausePickerSubmit';
import { InvestigationSummary, SecondOpinionFindings } from './SecondOpinion';
import { PreReviewSummary } from './PreReview';
import { GpcSection, RecallSection } from './Reference';
import { REJECT_REASONS } from './review-options';
import { load, type ResultRow } from './data';

export const dynamic = 'force-dynamic';

/**
 * 화면 D — 사건 분석 · 검토 (설계문서 §8.4, 2026-09-14 인사이트와 분리)
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
 *
 * 사건 요약·품목·적용기준 같은 공통 부분은 `layout.tsx` 가 그린다.
 *
 * 한 화면 순서 (05_02 P2, 2026-10-07 — 인사이트 화면을 합쳤다)
 *   1. 보고서가 실제로 한 시험 (사고) — 「이미 했는가」를 판정할 근거
 *   2. 관련될 수 있는 조항 — 기본 목록, 채택·반려 (단축키 j·k·a·r)
 *   3. 병행 점검 소견 — 기본 목록 **아래** (CLAUDE.md §13 원칙 2)
 *   4. 참고 — GPC 품목분류, 해외 리콜 근거
 *   5. 다음 사건 →
 * 전에는 병행 점검 미판정 큐가 조항 목록 위에 있었고, 근거는 다른 화면에 있었다.
 * 채택·반려 기록이 0건이던 이유로 그 배치를 의심했다(05 §2.4).
 */

const SHORTLIST = 5;

const ANALYSIS_TOC: TocItem[] = [
  { id: 'analysis-pre-review', label: '사전 검토 다섯 가지' },
  { id: 'analysis-investigation', label: '보고서가 한 시험' },
  { id: 'analysis-results', label: '관련될 수 있는 조항' },
  { id: 'analysis-second-opinion', label: '병행 점검 소견' },
  { id: 'analysis-reference', label: '참고' },
];

/** 사고보고서에만 있는 구역 — 리콜은 원인이 이미 적혀 있어 병행 점검 대상이 아니다 */
const ACCIDENT_ONLY_IDS = new Set(['analysis-pre-review', 'analysis-investigation', 'analysis-second-opinion']);

/**
 * 같은 종류에서 아직 판정하지 않은 후보가 남은 다음 사건 (05_02 P2-5)
 *
 * 한 건을 끝내도 다음 건으로 가는 길이 없어 목록으로 되돌아가야 했다. 지금 사건보다
 * 번호가 큰 것을 먼저, 없으면 처음부터 찾는다 — 차례대로 돌다 보면 한 바퀴를 돈다.
 */
async function nextPendingCase(caseId: number, sourceType: string): Promise<number | null> {
  const [row] = await getDb()<{ id: number }[]>`
    select e.id::int from public.case_event e
    where e.source_type = ${sourceType} and e.id <> ${caseId}
      and exists (
        select 1 from public.match_run r
        join public.match_result mr on mr.run_id = r.id
        where r.case_id = e.id
          and not exists (select 1 from public.review_log rl where rl.match_result_id = mr.id)
      )
    order by (e.id > ${caseId}) desc, e.id
    limit 1
  `;
  return row?.id ?? null;
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

function evidenceLevelOf(p: MatchPath, reviewed: boolean): EvidenceLevel {
  if (p === 'FALLBACK') return 'C';
  if ((p === 'CODE' || p === 'CODE-PARTIAL') && reviewed) return 'A';
  return 'B';
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
      // 판정하지 않은 후보만 단축키 대상이다 — 판정하면 빠지고 포커스가 다음 후보로 간다
      {...(decided ? {} : { 'data-review-row': true, tabIndex: -1 })}
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
        {/* 점수 숫자는 판정 근거가 아니다 — 마우스를 올리면 보이게만 둔다(05_02 P2-3) */}
        <span
          className="text-[11px] text-ink-3"
          title={`검색 점수 ${Number(r.search_score).toFixed(4)}${r.rerank_score != null ? ` · 재채점 ${Number(r.rerank_score).toFixed(2)}` : ''}`}
        >
          점수 ⓘ
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
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <ActionForm
            action={recordReview}
            hidden={{ matchResultId: r.id, caseId, decision: 'ADOPTED' }}
            label="채택"
            pendingLabel="채택하는 중…"
            className="border border-measure bg-measure px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-85"
            hotkeyRole="approve"
          />
          <ActionForm
            action={recordReview}
            hidden={{ matchResultId: r.id, caseId, decision: 'REJECTED' }}
            label="반려"
            pendingLabel="반려하는 중…"
            className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft"
            hotkeyRole="reject"
          >
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
          </ActionForm>
        </div>
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
        <CausePickerSubmit
          caseId={caseId}
          className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft"
        />
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

export default async function AnalysisReviewPage({
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

  // layout.tsx 가 이미 caseId 를 검증하고 못 찾으면 여기까지 오지 않는다 —
  // cache() 로 감싼 load() 라 같은 요청 안에서는 DB 를 다시 안 부른다.
  const data = await load(caseId);
  if (!data) return null;

  const { ev, tags, run, results, recall } = data;
  const shortlist = results.slice(0, SHORTLIST);
  const rest = results.slice(SHORTLIST);
  const hfUnresolved = tags.length > 0
    && causeUnresolved(tags.filter((t) => t.axis === 'HF').map((t) => t.code));
  const isAccident = ev.source_type === 'ACCIDENT';
  const toc = isAccident ? ANALYSIS_TOC : ANALYSIS_TOC.filter((t) => !ACCIDENT_ONLY_IDS.has(t.id));
  const nextCase = await nextPendingCase(ev.id, ev.source_type);

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
    <>
      <DoneBanner message={done} />

      {/* 사고 사전 검토 다섯 가지 — 아래 구역들의 요약이다(06_02 P1-2) */}
      {isAccident && <PreReviewSummary data={data} />}

      {isAccident && <InvestigationSummary caseId={ev.id} />}

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
            <span className="text-[11px] text-ink-3">단축키 j·k 이동 · a 채택 · r 반려</span>
          </section>
          <ReviewShortcuts />

          {/*
            검색 방식·AI 사용 내역은 「근거 자세히」로 접는다 (05_02 P2-3)

            판정에 직접 쓰는 정보가 아니라 "왜 이 조항이 나왔나"를 되짚을 때 보는 것이다.
            펼쳐 두면 담당자에게는 시험 단계의 기술 정보로 읽혀 조항 목록이 밀린다.
          */}
          <details className="mt-2 border border-rule-soft px-3 py-2">
            <summary className="cursor-pointer text-[11px] text-ink-3">
              근거 자세히 — 어떻게 찾았나 (
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
              )
            </summary>
            {run.rerank_status === 'ok' && run.rerank_model && (
              <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                순서를 다시 매길 때 AI 를 썼습니다({run.rerank_model}). 저장된 결과는 다시 열어도 그대로지만,
                같은 조건으로 다시 돌리면 순서가 달라질 수 있습니다.
              </p>
            )}
            {/*
              AI 가 지어낸 검색용 문장(HyDE) (2026-09-08) — 어떤 조항이 후보로 떠오르는지를
              바꾸므로(재현율 23.8% → 25.2%) 되짚을 수 있게 남긴다. 기준 원문이 아니라는
              점을 먼저 밝힌다.
            */}
            {run.hyde_text && (
              <div className="mt-2">
                <div className="text-[11px] text-ink-3">
                  🤖 검색에 쓴 「가상 조항」 — AI가 지어낸 문장입니다 (기준 원문 아님)
                </div>
                <p className="mt-1 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">
                  {run.hyde_text}
                </p>
                <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                  사고 서술만으로는 기준의 문체와 어휘가 달라 의미 검색이 빗나갑니다. 그래서
                  「답에 해당할 법한 조항」을 AI에게 지어내게 해 그 문장으로 검색합니다. 위 문장은
                  <strong className="font-semibold"> 실제 안전기준에 존재하지 않습니다.</strong> 검색이
                  왜 이 방향으로 갔는지를 되짚는 용도이며, 근거로 인용해서는 안 됩니다.
                </p>
              </div>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
              조항마다 붙은 「점수 ⓘ」에 마우스를 올리면 검색·재채점 점수가 보입니다.
            </p>
          </details>

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
                관리 콘솔(진척 현황)에서 준비 상태 먼저 확인.
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

      {/* 병행 점검 — 기본 조항 목록 아래 (CLAUDE.md §13 원칙 2). 근거와 판정 버튼이 함께 있다 */}
      {isAccident && <SecondOpinionFindings caseId={ev.id} />}

      <section id="analysis-reference" className="mt-10 scroll-mt-8 border-t border-rule pt-5">
        <h2 className="text-[15px] font-semibold">참고</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
          판정에 직접 쓰지 않는 배경 자료입니다 — 품목분류 후보와 해외 리콜 공고의 근거.
        </p>
        <GpcSection ev={ev} />
        <RecallSection recall={recall} />
        {!ev.gpc_candidates?.length && !recall && (
          <p className="mt-3 text-[12px] text-ink-3">이 사건에는 참고 자료가 없습니다.</p>
        )}
      </section>

      <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-5">
        <Link href={isAccident ? '/accidents' : '/recalls?stage=link'} className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink">
          ← 목록으로
        </Link>
        {nextCase ? (
          <Link
            href={`/analysis/${nextCase}`}
            className="border border-measure px-4 py-2 text-[13px] font-medium text-measure hover:bg-measure-soft"
          >
            판정이 남은 다음 {isAccident ? '사고보고서' : '리콜'} →
          </Link>
        ) : (
          <span className="text-[12px] text-ink-3">판정이 남은 다른 사건이 없습니다</span>
        )}
      </div>

      <PageToc items={toc} />
    </>
  );
}
