import { ExternalLinkPreview } from './ExternalLinkPreview';
import type { RecallOverviewData } from '@/lib/recall/overview';

/**
 * 리콜 개요 — 표 + 사진 (2026-09-14, 담당자 요청)
 *
 * "사고보고서 원문 전체 보기"를 리콜에도 그대로 썼더니 안 맞았다 — 사고보고서는
 * 사람이 쓴 서술문이지만 리콜은 API 응답 필드를 이어붙인 것이라, 그 narrative를
 * 텍스트로 그대로 펼치면 읽기 어렵다는 지적을 받았다. 사진과 핵심 항목만 표로
 * 먼저 보여주고, 긴 설명(제품 설명·위해 내용·리콜 사유·소비자 조치)은 접어 둔다 —
 * 사고보고서 원문 미리보기와 같은 "일부만 먼저, 필요하면 펼쳐서" 원칙이다.
 *
 * 두 자리에서 쓴다 — 리콜 사건 자신의 상세 화면(`analysis/[caseId]/layout.tsx`)과,
 * 사고보고서 인사이트의 "관련 리콜" 참조(`SecondOpinion.tsx`의 유사 사례). 후자는
 * 여러 건이 한 화면에 늘어설 수 있어 사진을 3장까지만 보여준다.
 */
export function RecallOverview({ data }: { data: RecallOverviewData }) {
  const rows: Array<[string, string]> = ([
    ['제품명', data.title ?? ''],
    ['브랜드 · 모델', [data.brand, data.model].filter(Boolean).join(' · ')],
    ['제조국', data.countryOfOrigin ?? ''],
    ['리콜 국가', data.recallCountry ?? ''],
    ['위해 유형', data.hazardType ?? ''],
    ['대상 수량', data.unitsAffected ?? ''],
    ['공표일', data.publishedOn ?? ''],
  ] as Array<[string, string]>).filter(([, v]) => v);

  const hasDetail = data.productDescription || data.hazardSummary || data.recallCause || data.consumerAction;

  return (
    <div className="border border-rule-soft bg-surface">
      {data.images.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-b border-rule-soft p-2">
          {data.images.slice(0, 3).map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- 원본 Storage URL, 도메인이 리콜마다 달라 next/image 최적화 대상이 아니다
            <img
              key={i}
              src={src}
              alt={`${data.title ?? '리콜'} 사진 ${i + 1}`}
              className="h-28 w-28 shrink-0 border border-rule-soft object-cover"
            />
          ))}
          {data.images.length > 3 && (
            <span className="flex h-28 w-16 shrink-0 items-center justify-center border border-rule-soft text-[11px] text-ink-3">
              +{data.images.length - 3}장
            </span>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <table className="w-full text-[12px]">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label} className="border-b border-rule-soft last:border-0">
                <th className="w-24 shrink-0 px-3 py-1.5 text-left align-top font-medium whitespace-nowrap text-ink-3">
                  {label}
                </th>
                <td className="px-3 py-1.5 text-ink-2">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {hasDetail && (
        <details className="border-t border-rule-soft px-3 py-2">
          <summary className="cursor-pointer text-[11px] text-ink-3 hover:text-ink">
            제품 설명 · 위해 내용 · 리콜 사유 전체 보기
          </summary>
          <div className="mt-2 space-y-2 text-[12px] leading-relaxed text-ink-2">
            {data.productDescription && (
              <p><span className="text-ink-3">제품 설명 — </span>{data.productDescription}</p>
            )}
            {data.hazardSummary && (
              <p><span className="text-ink-3">위해 내용 — </span>{data.hazardSummary}</p>
            )}
            {data.recallCause && (
              <p><span className="text-ink-3">리콜 사유 — </span>{data.recallCause}</p>
            )}
            {data.consumerAction && (
              <p><span className="text-ink-3">소비자 조치 — </span>{data.consumerAction}</p>
            )}
          </div>
        </details>
      )}

      {data.detailUrl && (
        <div className="border-t border-rule-soft px-3 py-1.5 text-[11px]">
          <ExternalLinkPreview href={data.detailUrl} label="원본 공고 보기" className="text-measure underline underline-offset-2" />
        </div>
      )}
    </div>
  );
}
