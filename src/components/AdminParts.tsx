/**
 * 관리 화면(/admin) 여러 탭이 함께 쓰는 작은 조각들
 *
 * 전에는 운영(/ops)과 AI 사용(/llm) 화면이 같은 코드를 각자 복사해 두고 있었다.
 * 두 화면을 관리 화면 하나로 합치면서 한 군데로 모았다 — 한쪽만 고쳐 두 탭의
 * 모양이 어긋나는 일을 막기 위해서다(CLAUDE.md §9).
 */

export function Signal({
  label, value, level, note,
}: { label: string; value: string; level: 'ok' | 'caution' | 'halt'; note?: string }) {
  const tone = level === 'halt' ? 'text-halt' : level === 'caution' ? 'text-caution' : 'text-measure';
  const dot = level === 'halt' ? 'bg-halt' : level === 'caution' ? 'bg-caution' : 'bg-measure';
  return (
    <div className="border-t border-rule py-3">
      <div className="flex items-baseline gap-2">
        <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="label">{label}</span>
      </div>
      <div className={`mt-1 text-[14px] font-medium ${tone}`}>{value}</div>
      {note && <div className="mt-1 text-[11px] leading-snug text-ink-3">{note}</div>}
    </div>
  );
}

export function Section({
  id, title, lead, children,
}: { id: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-12 scroll-mt-8">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {lead && <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-ink-2">{lead}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function when(iso: string | null): string {
  if (!iso) return '기록 없음';
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

/** 자료 종류 이름 — 담당자 지적으로 "사건"을 사고보고서·리콜로 나눴다 */
export const TARGET_LABEL: Record<string, string> = {
  clause: '안전기준 조항',
  accident: '사고보고서',
  recall: '리콜',
};
