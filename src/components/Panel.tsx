import Link from 'next/link';

/** 화면 머리 — 라벨·제목·한 줄 설명. 화면마다 같은 자리에 같은 형태로 둔다 */
export function PageHead({
  label, title, lead,
}: { label: string; title: string; lead?: string }) {
  return (
    <header>
      <div className="label">{label}</div>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight">{title}</h1>
      {lead && <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-ink-2">{lead}</p>}
    </header>
  );
}

/**
 * 연결 실패 — 시스템이 잘못된 유일한 경우이므로 여기서만 적색을 쓴다.
 * 무엇이 잘못됐고 어떻게 고치는지 말한다. 사과하지 않는다.
 */
export function ConnectionError({ error }: { error: string }) {
  return (
    <section className="mt-8 border border-halt bg-halt-soft px-5 py-4">
      <div className="text-[13px] font-semibold text-halt">데이터베이스에 연결하지 못했습니다</div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
        <code className="addr">.env.local</code> 의 <code className="addr">DATABASE_URL</code> 을
        채우세요. Supabase 대시보드의 <span className="text-ink">Connect → Session pooler</span>{' '}
        연결 문자열입니다.
      </p>
      <pre className="addr mt-3 overflow-x-auto border border-rule bg-surface px-3 py-2 text-[11px] text-ink-2">
        {error}
      </pre>
    </section>
  );
}

/** 빈 화면은 안내가 아니라 다음 행동으로의 초대다 */
export function EmptyState({
  message, commands,
}: { message: string; commands?: Array<{ cmd: string; note: string }> }) {
  return (
    <section className="mt-8 border-t border-rule pt-6">
      <p className="text-[13px] text-ink-2">{message}</p>
      {commands?.length ? (
        <ol className="mt-3 space-y-2">
          {commands.map((c) => (
            <li key={c.cmd} className="text-[13px]">
              <code className="addr text-ink">{c.cmd}</code>
              <span className="ml-2 text-[12px] text-ink-3">{c.note}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function Row({ href, children }: { href?: string; children: React.ReactNode }) {
  const inner = (
    <div className="border-t border-rule py-3.5 transition-colors hover:bg-measure-soft/30">
      {children}
    </div>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}
