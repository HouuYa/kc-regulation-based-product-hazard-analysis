import { loadSecondOpinion } from '@/lib/second-opinion/load';
import { sectionKinds } from '@/lib/second-opinion/narrative';
import { buildCertCheck } from '@/lib/second-opinion/cert-check';
import { loadCodebookSnapshot, codeLabelMap } from '@/lib/codebook/snapshot';
import type { CaseData } from './data';

/**
 * 사고 사전 검토 — 다섯 결과 한 장 (06_02 P1-1·P1-2, 2026-10-08)
 *
 * 담당자 결정: 접수 양식은 결과 보고서와 같고, 조사 전·조사 뒤 사전 검토는 하나의 서비스다.
 * 결과는 다섯 가지로 통일한다 — 제품분류 · HF-DT · 시험 후보 · 인증·표시(불법) 확인 · 닮은 리콜.
 *
 * 양식의 결과 칸(조사 방법·결과·결론)이 비어 있으면 「조사 전」, 채워져 있으면 「조사 뒤」다.
 * 채워진 칸은 근거로 쓰고 빈 칸은 후보로 채운다 — 이 요약은 그 구분을 맨 위에 밝힌다.
 *
 * 새 계산은 거의 없다. 아래 기존 구역(조항 후보·병행 점검·참고)과 같은 데이터를 요약하고,
 * 「자세히」로 그 구역에 잇는다. 4번만 새 함수(cert-check.ts)다 — 조사 전에는 동일성 확인
 * 결과가 없어 기존 불법 신호가 아무것도 내지 않기 때문이다.
 */

/** 보고서 양식의 품목분류 칸에 적힌 GPC 브릭 — 새 양식은 「GPCK 배터리 10000546」처럼 적는다 */
function statedBrick(narrative: string): string | null {
  return narrative.slice(0, 2000).match(/GPC\s?K?\s?[^\d\n]{0,30}?(\d{8})/)?.[1] ?? null;
}

function Card({
  no, title, children, href,
}: { no: number; title: string; children: React.ReactNode; href?: string }) {
  return (
    <div className="flex flex-col border border-rule bg-surface px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="addr text-[11px] text-ink-3">{no}</span>
        <span className="text-[13px] font-semibold">{title}</span>
      </div>
      <div className="mt-2 flex-1 space-y-1 text-[12px] leading-relaxed text-ink-2">{children}</div>
      {href && (
        <a href={href} className="mt-2 self-start text-[11px] text-measure underline underline-offset-2">
          자세히 ↓
        </a>
      )}
    </div>
  );
}

export async function PreReviewSummary({ data }: { data: CaseData }) {
  const { ev, tags, results, standards, standardIds } = data;
  const kinds = sectionKinds(ev.narrative);
  const afterInvestigation = kinds.some((k) => k === 'METHOD' || k === 'RESULT' || k === 'CONCLUSION');

  const [view, cert, snapshot] = await Promise.all([
    loadSecondOpinion(ev.id),
    buildCertCheck(ev.id, standardIds),
    loadCodebookSnapshot(),
  ]);
  const labels = codeLabelMap(snapshot);
  const name = (code: string) => `${labels.get(code) ?? code}`;

  const dt = tags.filter((t) => t.axis === 'DT');
  const hf = tags.filter((t) => t.axis === 'HF');
  const hfKnown = hf.filter((t) => t.code !== 'HF.UNKNOWN');
  const stated = statedBrick(ev.narrative);

  const findings = view?.findings ?? [];
  const gap = findings.filter((f) => f.findingType === 'TEST_GAP').length;
  const causeCandidates = findings.filter((f) => f.findingType === 'RECALL_EVIDENCE' && !f.refCaseId);
  const similar = new Set(findings.filter((f) => f.findingType === 'RECALL_EVIDENCE' && f.refCaseId).map((f) => f.refCaseId));

  return (
    <section id="analysis-pre-review" className="mt-8 scroll-mt-8 border-t border-rule pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold">사고 사전 검토 — 다섯 가지</h2>
        <span
          className={`border px-2 py-0.5 text-[11px] ${afterInvestigation ? 'border-rule text-ink-2' : 'border-measure text-measure'}`}
          title="양식의 「조사 방법·결과·결론」 칸이 채워져 있는가로 가른다"
        >
          {afterInvestigation ? '조사 뒤 — 결과 칸 채워짐: 근거로 씀' : '조사 전 — 결과 칸 비어 있음: 후보로 채움'}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
        담당자가 확정하기 전의 검토 자료입니다. 위반 여부를 판정하지 않습니다. 시험 후보(불량)와 인증·표시 확인(불법)은 따로 봅니다.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Card no={1} title="제품분류" href="#analysis-scope">
          <div>품목 <span className="text-ink">{ev.scope_name ?? ev.item_name ?? '미정'}</span></div>
          <div>적용 기준 {standards.length > 0 ? `${standards.length}종` : <span className="text-caution">못 찾음</span>}</div>
          <div>
            GPC {ev.gpc_brick_code ?? <span className="text-ink-3">없음</span>}
            {stated && (
              <span className={stated === ev.gpc_brick_code ? 'text-measure' : 'text-caution'}>
                {' '}· 보고서 기재 {stated} {stated === ev.gpc_brick_code ? '(일치)' : '(다름)'}
              </span>
            )}
          </div>
        </Card>

        <Card no={2} title="HF-DT" href={afterInvestigation ? undefined : '#analysis-second-opinion'}>
          <div>피해유형 {dt.length ? dt.map((t) => name(t.code)).join(' · ') : <span className="text-caution">없음</span>}</div>
          <div>
            원인{' '}
            {hfKnown.length
              ? hfKnown.map((t) => name(t.code)).join(' · ')
              : <span className="text-ink-3">미상{afterInvestigation ? ' — 조사로 밝히지 못함' : ''}</span>}
          </div>
          {!hfKnown.length && causeCandidates.length > 0 && (
            <div className="text-ink-3">원인 후보 {causeCandidates.length}개 — 닮은 리콜 통계 근거</div>
          )}
        </Card>

        <Card no={3} title="시험 후보" href="#analysis-results">
          <div>관련 조항 후보 {results.length > 0 ? `${results.length}건` : <span className="text-ink-3">아직 분석 안 함</span>}</div>
          {view && afterInvestigation && (
            <>
              <div>보고서가 한 시험 {view.performedTestCount}건</div>
              <div>하지 않은 구간 {gap > 0 ? <span className="text-caution">{gap}건</span> : '0건'}</div>
            </>
          )}
        </Card>

        <Card no={4} title="인증·표시(불법) 확인" href={cert.legalSignals || cert.identityResults.length ? '#analysis-second-opinion' : undefined}>
          <div>
            인증 구분{' '}
            {cert.certTypes.length
              ? cert.certTypes.map((c) => c.value).join('·')
              : <span className="text-caution">알 수 없음</span>}
            {cert.certTypes[0] && <span className="text-ink-3"> ({cert.certTypes[0].source})</span>}
          </div>
          <ul className="list-disc pl-4">
            {cert.items.map((i) => <li key={i.key} title={i.why}>{i.label}</li>)}
          </ul>
          {cert.identityResults.length > 0 && (
            <div>
              동일성 확인 결과{' '}
              {cert.identityResults.map((r, i) => (
                <span key={i} className={r.verdict === '상이함' ? 'text-halt' : 'text-ink-2'}>{r.verdict ?? r.label}{' '}</span>
              ))}
              <span className="text-ink-3">(인증기관 유권해석)</span>
            </div>
          )}
          {cert.legalSignals > 0 && <div className="text-halt">불법 신호 {cert.legalSignals}건</div>}
        </Card>

        <Card no={5} title="닮은 리콜" href={similar.size ? '#analysis-second-opinion-recall' : undefined}>
          <div>해외 리콜 {similar.size}건</div>
          <div className="text-ink-3">국내 리콜은 자료가 쌓이면 함께 비교합니다</div>
        </Card>
      </div>
    </section>
  );
}
