import { ExternalLinkPreview } from '@/components/ExternalLinkPreview';
import type { GpcMatchLevel } from '@/lib/gpc/verify';
import { GPC_SOURCE_LABEL, GPC_SOURCE_NOTE, needsReview, type GpcSource } from '@/lib/gpc/provenance';
import type { CaseEventRow, RecallRow } from './data';

/**
 * 사건 검토 화면의 「참고」 구역 — GPC 품목분류, 해외 리콜 근거 (05_02 P2-1, 2026-10-07)
 *
 * 전에는 「인사이트 화면」(`/analysis/[id]/insight`)에 있었다. 검토 화면과 나누자
 * 판정에 필요한 근거와 판정 버튼이 서로 다른 화면에 놓였다 — 담당자가 두 화면을
 * 오가야 했다(05 §2.4). 한 화면으로 합치면서, 판정에 직접 쓰지 않는 이 두 구역은
 * 맨 아래 참고로 내렸다. 내용은 옮기기만 하고 바꾸지 않았다.
 *
 * 국내 유통 확인은 여기서 뺐다 — 리콜 분석자 1단계 입력이라 화면 위쪽 품목 칸
 * 옆으로 올렸다(layout.tsx).
 */

const GPC_LEVEL_LABEL: Record<Exclude<GpcMatchLevel, 'NONE'>, string> = {
  BRICK: 'Brick', CLASS: 'Class', FAMILY: 'Family', SEGMENT: 'Segment',
};

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

/* GPC(GS1 국제 품목분류) 후보 — 사고사진 비전 분석에서 뽑은 제품 서술로 조회한 것.
   라운드 12부터 standard 와 같은 방식(findAndVerifyGpc)으로 LLM 1차 검증을 거친다.
   검증됐어도 확정으로 단정하지 않는다 — 이 화면의 "판정하지 않는다" 원칙은 그대로다. */
export function GpcSection({ ev }: { ev: CaseEventRow }) {
  if (!ev.gpc_candidates || ev.gpc_candidates.length === 0) return null;
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
          {/* 순위·유사도 숫자는 검증이 어디서 왔는지 되짚을 때만 필요하다 — 접어 둔다(05_02 P2-3) */}
          <details className="mt-2">
            <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink">
              후보 순위 {ev.gpc_candidates.length}건 보기
            </summary>
            <ul className="mt-2 space-y-1">
              {ev.gpc_candidates.map((c) => {
                const isVerifiedBrick =
                  ev.gpc_verified_level === 'BRICK' && c.brickCode === ev.gpc_verified_brick_code;
                return (
                  <li
                    key={c.rank}
                    className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 py-1 text-[12px] ${
                      isVerifiedBrick ? 'border border-measure text-measure' : 'text-ink-2'
                    }`}
                  >
                    <span className="addr tnum text-ink-3">{c.rank}위</span>
                    <span className="addr">{c.brickCode}</span>
                    <span className="font-medium">{c.brickTitle}</span>
                    {isVerifiedBrick && (
                      <span className="text-[10px] font-medium text-measure">검증 확정</span>
                    )}
                    <span className="text-ink-3">
                      {c.segmentTitle} &gt; {c.familyTitle} &gt; {c.classTitle}
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        </div>
      </div>
    </section>
  );
}

/* 트랙 B — 해외 리콜에만 있는 것들 */
export function RecallSection({ recall }: { recall: RecallRow | undefined }) {
  if (!recall) return null;
  return (
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
                <ExternalLinkPreview
                  href={recall.detail_url}
                  label="원문 보기"
                  className="text-measure underline underline-offset-2"
                />
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
        </div>
      </div>
    </section>
  );
}
