import { getDb } from '@/lib/db';
import { loadBridge, type BridgeRow, type CauseRoute } from '@/lib/codebook/cause-bridge';
import { PageHead, ConnectionError, EmptyState, TermsNote } from '@/components/Panel';
import { PageToc, type TocItem } from '@/components/PageToc';

export const dynamic = 'force-dynamic';

const CODEBOOK_TOC: TocItem[] = [
  { id: 'codebook-current', label: '현재 코드북 판' },
  { id: 'codebook-bridge', label: '결과 → 원인 다리' },
  { id: 'codebook-hf', label: '위해요인 HF' },
  { id: 'codebook-dt', label: '피해유형 DT' },
];

/** 확인 경로를 담당자 말로 옮긴다. 코드값을 그대로 보이면 뜻이 전달되지 않는다 */
const ROUTE_LABEL: Record<CauseRoute, { name: string; hint: string }> = {
  TEST: { name: '시험', hint: '불량 — 안전기준 시험으로 확인한다' },
  LEGAL: { name: '법령', hint: '불법 — 인증·표시 위반이라 시험 대상이 아니다' },
  GAP: { name: '기준공백', hint: '기준 자체가 없거나 미흡하다' },
  OTHER: { name: '기타', hint: '관리·공정·사람 요인이라 시험으로 확인할 수 없다' },
};

/**
 * 위해요인 코드북 — 참고 문서 (조회 전용)
 *
 * 왼쪽 레일에서 업무 단계(1~3) 아래로 내렸다. 담당자가 여기서 할 일이 없기 때문이다 —
 * 조회만 하는 대상이고, 적재는 관리자 명령으로 한다.
 *
 * v0.7 §0.4 는 "코드북 업로드 전용 화면"을 삭제 대상으로 지목했다. 관리자 스크립트와
 * 검증 리포트로 충분하기 때문이다. 그 결정을 뒤집지 않는다 — 여기서는 올리지 않고,
 * 지금 무엇이 유효한지와 버전이 바뀌면 무엇이 영향을 받는지만 보여 준다.
 *
 * 버전이 바뀔 때를 다루는 방법 (담당자 요청으로 추가)
 *   코드북이 개정되면 이미 붙여 놓은 코드가 옛 판 기준이 된다. 그런데 그 사실이
 *   지금까지 어디에도 보이지 않았다. DB 에는 이미 재료가 다 있었다 —
 *   태깅마다 codebook_version 이 기록돼 있고(003·004), 두 판의 차이를 계산하는
 *   diff_versions() 함수도 있다(codebook/sql/002). 화면으로 꺼내기만 하면 됐다.
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

interface UsageRow {
  codebook_version: string;
  clause_tags: number;
  case_tags: number;
}

interface DiffRow {
  change_type: string;
  axis: string;
  code: string;
  name_before: string | null;
  name_after: string | null;
}

const CHANGE_LABEL: Record<string, string> = {
  ADDED: '새로 생김',
  REMOVED: '없어짐',
  CHANGED: '이름·정의 바뀜',
};

export default async function CodebookPage() {
  let version: { version: string; effective_date: string | null } | null = null;
  let codes: CodeRow[] = [];
  let constraints: { subject_prefix: string; requires_any_of: string[]; reason: string }[] = [];
  let usage: UsageRow[] = [];
  let diffs: DiffRow[] = [];
  let staleVersion: string | null = null;
  let bridge: BridgeRow[] = [];
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

      // 어느 판으로 붙인 코드가 몇 건인가 — 개정 시 영향 범위의 근거
      usage = await db<UsageRow[]>`
        select codebook_version,
               count(*) filter (where src = 'clause')::int as clause_tags,
               count(*) filter (where src = 'case')::int   as case_tags
        from (
          select codebook_version, 'clause' as src from public.clause_tag
          union all
          select codebook_version, 'case'   as src from public.case_tag
        ) t
        where codebook_version is not null
        group by codebook_version
        order by codebook_version
      `;

      // 유효 판이 아닌 것으로 붙은 태깅이 있으면 무엇이 달라졌는지 보여 준다
      const stale = usage.find((u) => u.codebook_version !== version!.version);
      if (stale) {
        staleVersion = stale.codebook_version;
        diffs = await db<DiffRow[]>`
          select change_type, axis, code, name_before, name_after
          from public.diff_versions(${stale.codebook_version}, ${version.version})
          order by change_type, axis, code
          limit 50
        `;
      }

      bridge = await loadBridge();
    }
  } catch (e) {
    console.error('코드북 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  const hf = codes.filter((c) => c.axis === 'HF');
  const dt = codes.filter((c) => c.axis === 'DT');

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_10rem]">
      <div>
      <PageHead
        label="참고 · 위해요인 코드"
        title={version ? `코드북 ${version.version}` : '위해요인 코드북'}
        lead="사고 원인과 피해 유형을 나눠 보는 코드 목록입니다. 이 화면에서는 내용을 바꾸지 않습니다."
        workflow={[
          { label: '현재 판 확인' },
          { label: '코드 뜻 보기', href: '#codebook-hf' },
          { label: '변경 확인', href: '#codebook-current' },
        ]}
      />

      {error && <ConnectionError error={error} />}

      {!error && !version && (
        <EmptyState
          message="유효한 코드북 판이 없습니다."
          commands={[
            { cmd: 'npm run codebook:inspect', note: '넣기 전에 읽어들인 결과를 확인합니다' },
            { cmd: 'npm run codebook:load -- --activate', note: '새 판을 넣고 지금 쓰는 판으로 바꿉니다' },
          ]}
        />
      )}

      {version && (
        <section id="codebook-current" className="mt-9 scroll-mt-8 border-t border-rule pt-5">
          <div className="label">지금 쓰는 판</div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="addr text-[20px] font-medium">{version.version}</span>
            {version.effective_date && (
              <span className="text-[12px] text-ink-3">시행 {version.effective_date}</span>
            )}
            <span className="text-[12px] text-ink-3">
              원인(HF) {hf.length}개 · 피해유형(DT) {dt.length}개
            </span>
          </div>

          {usage.length > 0 && (
            <div className="mt-4">
              <div className="label pb-1">판별로 붙어 있는 코드</div>
              {usage.map((u) => {
                const isCurrent = u.codebook_version === version!.version;
                return (
                  <div
                    key={u.codebook_version}
                    className="flex flex-wrap items-baseline gap-x-4 border-t border-rule py-2 text-[12px]"
                  >
                    <span className={`addr ${isCurrent ? 'text-ink' : 'text-caution'}`}>
                      {u.codebook_version}
                    </span>
                    <span className="text-ink-3">
                      조항 {u.clause_tags.toLocaleString()}건 · 사건 {u.case_tags.toLocaleString()}건
                    </span>
                    {!isCurrent && <span className="text-caution">옛 판 기준입니다</span>}
                  </div>
                );
              })}
            </div>
          )}

          {staleVersion && (
            <div className="mt-5 border border-caution bg-caution-soft px-4 py-3">
              <div className="text-[13px] font-semibold text-caution">
                옛 판({staleVersion})으로 붙은 코드가 남아 있습니다
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                아래는 {staleVersion} 에서 {version.version} 로 오면서 달라진 코드입니다.
                <span className="text-ink"> 없어진 코드</span>로 붙어 있는 자료는 코드로 찾는
                방식에서 걸리지 않으므로, 그 범위만 다시 코드 부여를 하면 됩니다.
              </p>
              <div className="mt-3">
                {diffs.map((d) => (
                  <div key={`${d.axis}-${d.code}`} className="border-t border-caution/25 py-1.5 text-[12px]">
                    <span className="addr text-ink">{d.code}</span>
                    <span className="ml-2 text-ink-3">{CHANGE_LABEL[d.change_type] ?? d.change_type}</span>
                    <span className="ml-2 text-ink-2">
                      {d.name_before && d.name_after && d.name_before !== d.name_after
                        ? `${d.name_before} → ${d.name_after}`
                        : (d.name_after ?? d.name_before ?? '')}
                    </span>
                  </div>
                ))}
                {diffs.length === 0 && (
                  <p className="text-[12px] text-ink-2">두 판 사이에 코드 목록 변화는 없습니다.</p>
                )}
              </div>
            </div>
          )}

          <details className="mt-5">
            <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink">
              새 판이 나왔을 때 하는 일
            </summary>
            <ol className="mt-3 space-y-2 text-[12px] leading-relaxed text-ink-2">
              <li>
                <span className="text-ink">1.</span>{' '}
                <code className="addr text-ink">npm run codebook:inspect</code> — 새 파일을 읽어
                코드 수와 형식이 맞는지 먼저 봅니다. 아직 아무것도 바뀌지 않습니다.
              </li>
              <li>
                <span className="text-ink">2.</span>{' '}
                <code className="addr text-ink">npm run codebook:load -- --activate</code> —
                새 판을 넣고 유효 판으로 지정합니다. 옛 판은 지워지지 않고 남습니다.
              </li>
              <li>
                <span className="text-ink">3.</span> 이 화면으로 돌아와 위의 「옛 판으로 붙은 코드」
                를 확인합니다. 없어진 코드가 있으면 그 범위만 다시 코드 부여를 합니다 —
                운영 화면의 「위해요인 코드 부여」 또는{' '}
                <code className="addr text-ink">npm run tag -- --retag</code>.
              </li>
            </ol>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
              담당자가 검수해 확정한 코드는 다시 부여해도 덮어쓰지 않습니다(§3.3). 판을 바꿔도
              사람이 내린 판단은 그대로 남습니다.
            </p>
          </details>
        </section>
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

      {/*
        결과 → 원인 다리

        HF 목록과 DT 목록은 있었지만 둘을 잇는 줄이 없었다. 사고보고서 77%가 원인
        미상이라 담당자는 피해에서 원인을 짐작해야 하는데, 그 짐작을 도울 근거가
        시스템에 없던 것이다. 리콜 자료에서 세어 만든 표가 이 자리에 온다.

        고치는 기능은 두지 않는다. 이 화면은 조회 전용이고(v0.7 §0.4), 초기값이
        얼마나 맞는지 세어 보기 전에는 검수 화면을 만들지 않기로 했다(04-1 §9).
      */}
      {bridge.length > 0 && (
        <section id="codebook-bridge" className="mt-10 scroll-mt-8">
          <h2 className="text-[15px] font-semibold">
            결과 → 원인 다리
            <span className="addr ml-2 text-[12px] font-normal text-ink-3">{bridge.length}</span>
          </h2>
          <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-ink-3">
            어떤 피해가 났을 때 원인이 무엇이었는지를 해외 리콜 자료에서 세어 만든 표입니다.
            사고조사보고서는 열에 여덟이 원인 미상이라 여기서 셀 수 없지만, 리콜은 원인이
            적혀 있습니다. 원인이 밝혀지지 않은 사고에서 <strong className="font-semibold">원인
            후보를 좁히는 데</strong> 씁니다.
          </p>
          <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-ink-3">
            <strong className="font-semibold">시험</strong>으로 표시된 것만 시험항목을 찾는 데
            쓰입니다. 인증 위반·표시사항 같은 <strong className="font-semibold">법령</strong> 항목은
            불법이라 시험으로 확인할 수 없고, 담당자가 인증·표시를 직접 확인할 일입니다.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <a
              href="/api/codebook/cause-bridge/export"
              className="inline-block border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft"
            >
              CSV 내려받기
            </a>
            <span className="text-[11px] text-ink-3">
              {bridge[0]?.computedAt?.slice(0, 10)} 계산 · 다시 만들려면{' '}
              <span className="addr">npm run cause:build</span>
            </span>
          </div>

          <div className="mt-4">
            {Object.entries(
              bridge.reduce<Record<string, BridgeRow[]>>((acc, r) => {
                (acc[r.dtCode] ??= []).push(r);
                return acc;
              }, {}),
            ).map(([dtCode, rows]) => (
              <details key={dtCode} className="border-t border-rule py-2.5">
                <summary className="cursor-pointer">
                  <span className="text-[13px] font-medium">{rows[0].dtName ?? dtCode}</span>
                  <span className="addr ml-2 text-[11px] text-ink-3">{dtCode}</span>
                  <span className="ml-3 text-[11px] text-ink-3">
                    사건 {rows[0].sampleSize.toLocaleString()}건에서 원인 후보 {rows.length}개
                  </span>
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[36rem] text-[12px]">
                    <thead>
                      <tr className="text-ink-3">
                        <th className="py-1 pr-3 text-left font-normal">원인</th>
                        <th className="py-1 pr-3 text-left font-normal">확인 경로</th>
                        <th className="py-1 pr-3 text-right font-normal">근거</th>
                        <th className="py-1 pr-3 text-right font-normal">비율</th>
                        <th className="py-1 text-right font-normal">특이도</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.hfCode} className="border-t border-rule-soft">
                          <td className="py-1 pr-3">
                            {r.hfName ?? r.hfCode}
                            <span className="addr ml-2 text-[10px] text-ink-3">{r.hfCode}</span>
                          </td>
                          <td className="py-1 pr-3">
                            <span
                              title={ROUTE_LABEL[r.route].hint}
                              className={`border px-1.5 text-[10px] ${
                                r.route === 'TEST' ? 'border-measure text-measure' : 'border-rule text-ink-3'
                              }`}
                            >
                              {ROUTE_LABEL[r.route].name}
                            </span>
                          </td>
                          <td className="addr py-1 pr-3 text-right">{r.support.toLocaleString()}건</td>
                          <td className="addr py-1 pr-3 text-right">{(r.confidence * 100).toFixed(1)}%</td>
                          <td className="addr py-1 text-right text-ink-3">{r.lift.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>

          <p className="mt-3 max-w-3xl text-[11px] leading-relaxed text-ink-3">
            비율은 그 피해가 난 사건 중 이 원인이 함께 적힌 비율입니다. 특이도는 그 원인이
            이 피해에 유난히 몰리는 정도이고, 1에 가까우면 어느 사고에나 붙는 흔한 원인이라
            후보에서 뺍니다 — 설계결함이 그런 경우입니다.
          </p>
        </section>
      )}

      {[
        { title: '위해요인 (HF) — 왜 위험했는가', rows: hf },
        { title: '피해유형 (DT) — 어떤 피해가 났는가', rows: dt },
      ].map(
        (group) =>
          group.rows.length > 0 && (
            <section
              key={group.title}
              id={group.title.includes('(HF)') ? 'codebook-hf' : 'codebook-dt'}
              className="mt-10 scroll-mt-8"
            >
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

      <TermsNote />
      </div>
      <PageToc items={CODEBOOK_TOC} />
      </div>
    </div>
  );
}
