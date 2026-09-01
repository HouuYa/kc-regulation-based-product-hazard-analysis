import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState } from '@/components/Panel';

export const dynamic = 'force-dynamic';

/**
 * 위해요인 코드북 — 조회 전용 화면
 *
 * v0.7 §0.4 는 "코드북 업로드 전용 화면"을 삭제 대상으로 지목했다.
 * 관리자 스크립트와 검증 리포트로 충분하기 때문이다. 그래서 여기서는 올리지 않고,
 * 지금 무엇이 유효한지만 보여 준다. 적재는 npm run codebook:load 로 한다.
 *
 * L0·L1 을 눈에 띄게 표시하는 이유 (PDR §0.4)
 *   이 코드들은 단독 사용이 금지돼 있다. 사용자 행동은 계기이고 근본 원인은
 *   설계·관리 결함이므로 HF.M.DES 또는 HF.M.QMS 와 반드시 병기해야 한다.
 *   목록에서 구분되지 않으면 담당자가 단독으로 고르게 된다.
 */

interface CodeRow {
  axis: string;
  code: string;
  name_ko: string;
  definition: string | null;
  depth: number;
  is_recall_common: boolean;
}

export default async function CodebookPage() {
  let version: { version: string; effective_date: string | null } | null = null;
  let codes: CodeRow[] = [];
  let constraints: { subject_prefix: string; requires_any_of: string[]; reason: string }[] = [];
  let error: string | null = null;

  try {
    const db = getDb();
    [version] = await db<{ version: string; effective_date: string | null }[]>`
      select version, effective_date::text from codebook.version where status = 'active'
    `;
    if (version) {
      codes = await db<CodeRow[]>`
        select axis, code, name_ko, definition, depth, is_recall_common
        from public.get_codes(${version.version}, null, true)
      `;
      constraints = await db<typeof constraints>`
        select c.subject_prefix, c.requires_any_of, c.reason
        from codebook.code_constraint c
        join codebook.version v on v.id = c.version_id
        where v.version = ${version.version} and c.rule_type = 'REQUIRES_ANY_OF'
      `;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const hf = codes.filter((c) => c.axis === 'HF');
  const dt = codes.filter((c) => c.axis === 'DT');

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="2 · 위해요인 코드"
        title={version ? `코드북 ${version.version}` : '위해요인 코드북'}
        lead="원인(HF)과 결과(DT)를 나눠 붙이는 두 축의 코드입니다. 안전기준 조항과 사고보고서가 같은 코드를 쓰기 때문에 서로 맞춰 볼 수 있습니다."
      />

      {error && <ConnectionError error={error} />}

      {!error && !version && (
        <EmptyState
          message="유효한 코드북 버전이 없습니다."
          commands={[
            { cmd: 'npm run codebook:inspect', note: '적재 전에 파싱 결과를 확인합니다' },
            { cmd: 'npm run codebook:load -- --activate', note: '적재하고 유효 버전으로 지정합니다' },
          ]}
        />
      )}

      {constraints.length > 0 && (
        <section className="mt-9 border border-caution bg-caution-soft px-4 py-3">
          <div className="label text-caution">단독 사용 금지</div>
          {constraints.map((c) => (
            <p key={c.subject_prefix} className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
              <span className="addr text-ink">{c.subject_prefix}.*</span> 는{' '}
              <span className="addr text-ink">{c.requires_any_of.join(' 또는 ')}</span> 와 함께
              기록해야 합니다. {c.reason}
            </p>
          ))}
        </section>
      )}

      {[
        { title: '위해요인 (HF) — 왜 위험했는가', rows: hf },
        { title: '피해유형 (DT) — 어떤 피해가 났는가', rows: dt },
      ].map(
        (group) =>
          group.rows.length > 0 && (
            <section key={group.title} className="mt-10">
              <h2 className="text-[15px] font-semibold">
                {group.title}
                <span className="addr ml-2 text-[12px] font-normal text-ink-3">
                  {group.rows.length}
                </span>
              </h2>
              <div className="mt-3">
                {group.rows.map((c) => (
                  <div key={c.code} className="border-t border-rule py-2.5">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span
                        className="addr text-[12px]"
                        style={{ paddingLeft: `${(c.depth - 2) * 14}px` }}
                      >
                        {c.code}
                      </span>
                      <span className="text-[13px] font-medium">{c.name_ko}</span>
                      {!c.is_recall_common && (
                        <span className="border border-caution px-1.5 text-[10px] text-caution">
                          병기 필요
                        </span>
                      )}
                    </div>
                    {c.definition && (
                      <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{c.definition}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ),
      )}
    </div>
  );
}
