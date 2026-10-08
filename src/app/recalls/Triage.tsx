import { ActionForm } from '@/components/ActionForm';
import { setCaseScope } from '@/app/analysis/[caseId]/actions';
import type { ScopeOption } from '@/lib/cases/manual-scope';
import { setDomesticCheck } from './actions';

/**
 * 리콜 분석자 1단계 「국내 관련성」의 두 입력 (05_02 P1-1·P1-2)
 *
 * 리콜 목록의 줄과 사건 상세가 같은 부품을 쓴다 — 같은 판단을 두 곳에서 다르게
 * 그리면 한쪽만 고치게 된다(CLAUDE.md §9 의 화면판).
 */

const BTN = 'border px-2.5 py-1 text-[12px]';

export function DomesticCheckButtons({ caseId, current }: { caseId: number; current: string | null }) {
  const cur = current ?? 'UNCHECKED';
  const style = (v: string, base: string) =>
    `${BTN} ${cur === v ? 'border-measure bg-measure text-white' : base}`;
  return (
    <ActionForm
      action={setDomesticCheck}
      hidden={{ caseId }}
      buttons={[
        { value: 'DISTRIBUTED', label: '국내 유통됨', pendingLabel: '기록 중…', className: style('DISTRIBUTED', 'border-halt text-halt hover:bg-halt-soft') },
        { value: 'NOT_DISTRIBUTED', label: '유통 없음', pendingLabel: '기록 중…', className: style('NOT_DISTRIBUTED', 'border-rule text-ink-2 hover:bg-measure-soft') },
        { value: 'UNKNOWN', label: '알 수 없음', pendingLabel: '기록 중…', className: style('UNKNOWN', 'border-rule text-ink-2 hover:bg-measure-soft') },
        ...(cur !== 'UNCHECKED'
          ? [{ value: 'UNCHECKED', label: '취소', pendingLabel: '처리 중…', className: 'px-1.5 py-1 text-[11px] text-ink-3 underline underline-offset-2 hover:text-measure' }]
          : []),
      ]}
    />
  );
}

export function ScopePicker({
  caseId, currentId, options,
}: { caseId: number; currentId: number | null; options: ScopeOption[] }) {
  return (
    <ActionForm
      action={setCaseScope}
      hidden={{ caseId }}
      label={currentId ? '품목 바꾸기' : '품목 정하기'}
      pendingLabel="저장 중…"
      className={`${BTN} border-measure text-measure hover:bg-measure-soft`}
    >
      <select
        name="scopeId"
        defaultValue={currentId ?? ''}
        aria-label="품목"
        className="max-w-[16rem] border border-rule bg-surface px-2 py-1 text-[12px]"
      >
        <option value="">— 품목 고르기 (비우면 지정 해제) —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.category ? `[${o.category}] ` : ''}{o.name}
          </option>
        ))}
      </select>
      <input
        name="note"
        placeholder="근거 (예: 원본 공고의 제품 사진)"
        className="min-w-[10rem] flex-1 border border-rule bg-surface px-2 py-1 text-[12px]"
      />
    </ActionForm>
  );
}
