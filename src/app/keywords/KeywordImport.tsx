'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { previewImport, applyImport } from './actions';
import type { KeywordPreviewRow } from '@/lib/terms/keyword-csv';

/**
 * CSV 가져오기 — 무엇이 바뀌는지 먼저 보여 준 뒤에만 적용한다
 *
 * 사전이 바뀌면 어떤 품목으로 인식되는지가 바뀌고, 그러면 붙는 기준이 바뀐다.
 * 조용히 바뀌는 것이 이 체계에서 가장 나쁜 고장이라 두 단계로 나눈다.
 */
export function KeywordImport() {
  const [preview, setPreview] = useState<KeywordPreviewRow[] | null>(null);
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMessage(null);
    const content = await file.text();
    setText(content);
    start(async () => setPreview((await previewImport(content)).rows));
  }

  function onApply() {
    start(async () => {
      setMessage(await applyImport(text));
      setPreview(null);
      setText('');
      router.refresh();
    });
  }

  const counts = preview?.reduce<Record<string, number>>((a, r) => {
    a[r.change] = (a[r.change] ?? 0) + 1;
    return a;
  }, {});

  return (
    <div>
      <label className="inline-block cursor-pointer border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft">
        CSV 올리기
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
      </label>

      {pending && <span className="ml-3 text-[12px] text-ink-3">읽는 중…</span>}
      {message && <p className="mt-2 text-[12px] text-measure">{message}</p>}

      {preview && (
        <div className="mt-3 border border-rule px-4 py-3">
          <div className="label">반영하면 이렇게 바뀝니다</div>
          <p className="mt-1.5 text-[12px] text-ink-2">
            추가 {counts?.['추가'] ?? 0}건 · 상태 바뀜 {counts?.['상태 바뀜'] ?? 0}건 ·
            그대로 {counts?.['그대로'] ?? 0}건
          </p>
          <p className="mt-1 text-[11px] text-ink-3">
            파일에 없는 줄은 건드리지 않습니다. 지우는 것은 목록에서 하나씩 하세요.
          </p>

          <div className="mt-3 max-h-64 overflow-y-auto">
            {preview.filter((r) => r.change !== '그대로').slice(0, 60).map((r, i) => (
              <div key={i} className="border-t border-rule py-1.5 text-[12px]">
                <span className={r.change === '추가' ? 'text-measure' : 'text-caution'}>{r.change}</span>
                <span className="ml-2">{r.keyword}</span>
                <span className="ml-2 text-ink-3">→ {r.subItem ?? r.item} [{r.itemGroup}]</span>
                {r.before && <span className="ml-2 text-ink-3">({r.before} 에서)</span>}
              </div>
            ))}
          </div>

          <div className="mt-3 flex gap-3">
            <button
              type="button" onClick={onApply} disabled={pending}
              className="border border-measure bg-measure px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-85 disabled:opacity-50"
            >
              {pending ? '반영하는 중…' : '반영하기'}
            </button>
            <button
              type="button" onClick={() => { setPreview(null); setText(''); }}
              className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
