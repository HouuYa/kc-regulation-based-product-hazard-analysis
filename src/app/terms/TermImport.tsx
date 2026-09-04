'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { previewImport, applyImport, type PreviewResult } from './import-actions';

/**
 * CSV 가져오기 — 무엇이 바뀌는지 먼저 보여 준 뒤에만 적용한다
 *
 * 왜 두 단계인가
 *   사전이 바뀌면 검색 결과가 바뀐다. 조용히 바뀌는 것이 이 체계에서 가장 나쁜
 *   고장이다 — 어제와 다른 조항이 나오는데 아무도 이유를 모른다.
 *
 *   그래서 올린 파일을 먼저 지금 사전과 견주어 "새로 추가 N건, 검수상태 바뀜 N건"
 *   을 보여 주고, 담당자가 그것을 보고 눌렀을 때만 저장한다.
 *
 * 지우지 않는다
 *   CSV 에 없는 행은 건드리지 않는다. 담당자가 일부만 잘라 온 파일을 올렸을 때
 *   사전이 통째로 날아가면 안 되기 때문이다. 지우는 것은 목록에서 하나씩 한다.
 */
export function TermImport() {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [text, setText] = useState<string>('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMessage(null);
    const content = await file.text();
    setText(content);
    start(async () => {
      const r = await previewImport(content);
      setPreview(r);
    });
  }

  function onApply() {
    start(async () => {
      const msg = await applyImport(text);
      setMessage(msg);
      setPreview(null);
      setText('');
      router.refresh();
    });
  }

  const counts = preview?.rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.kind] = (acc[r.kind] ?? 0) + 1;
    return acc;
  }, {}) ?? {};
  const changing = (counts['새로 추가'] ?? 0) + (counts['검수상태 바뀜'] ?? 0);

  return (
    <div className="min-w-[18rem] flex-1">
      <label className="inline-block cursor-pointer border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft">
        CSV 올리기
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
      </label>

      {pending && <span className="ml-2 text-[11px] text-ink-3">읽는 중…</span>}
      {message && <p className="mt-2 text-[11px] leading-snug text-ink-2">{message}</p>}

      {preview && (
        <div className="mt-3 border border-caution bg-caution-soft px-3 py-3">
          <div className="text-[12px] font-semibold text-caution">
            적용하면 이렇게 바뀝니다
          </div>
          <ul className="mt-1.5 text-[12px] text-ink-2">
            {Object.entries(counts).map(([k, v]) => (
              <li key={k}>
                {k} <span className="addr tnum text-ink">{v}건</span>
              </li>
            ))}
          </ul>

          {counts['기준을 찾지 못함'] ? (
            <p className="mt-2 text-[11px] leading-relaxed text-halt">
              우리 DB 에 없는 기준을 가리키는 행은 넣지 않습니다. 기준 JSON 을 먼저 적재해야 합니다.
            </p>
          ) : null}

          {/* 바뀌는 행만 미리 보여 준다. 변화 없는 행까지 늘어놓으면 정작 볼 것이 묻힌다 */}
          <div className="mt-2 max-h-48 overflow-auto border-t border-caution/40 pt-2">
            {preview.rows
              .filter((r) => r.kind !== '변화 없음')
              .slice(0, 60)
              .map((r, i) => (
                <div key={i} className="py-0.5 text-[11px] text-ink-2">
                  <span className="text-ink-3">[{r.kind}]</span> {r.term} → <span className="addr">{r.standard}</span>
                  {r.note && <span className="text-ink-3"> · {r.note}</span>}
                </div>
              ))}
          </div>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onApply}
              disabled={pending || changing === 0}
              className="border border-measure bg-measure px-4 py-2 text-[13px] font-medium text-white hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {changing === 0 ? '바뀌는 것이 없습니다' : `${changing}건 적용`}
            </button>
            <button
              type="button"
              onClick={() => { setPreview(null); setText(''); }}
              className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
