import Link from 'next/link';
import { PageHead, ConnectionError, EmptyState, TermsNote, DoneBanner } from '@/components/Panel';
import { BoardToolbar, BoardPager, BoardTabs, SortHeader, type BoardParams } from '@/components/Board';
import { FILE_STATUS_LABEL } from '@/lib/terms';
import { GROUP_ORDER } from '@/lib/standards/label';
import { uploadAccidentPdfs, confirmCase } from './actions';
import { ActionForm } from '@/components/ActionForm';
import { PageToc, type TocItem } from '@/components/PageToc';
import { ScreenSwitch } from '@/components/ScreenSwitch';
import { runAnalysisAction } from '@/app/analysis/[caseId]/actions';
import { load, UPLOAD_STEPS, stepOf, when } from './data';

export const dynamic = 'force-dynamic';

const ACCIDENTS_TOC: TocItem[] = [
  { id: 'accidents-upload', label: '사고보고서 올리기' },
  { id: 'accidents-list', label: '사고보고서 목록' },
];

/**
 * 사고보고서 — 처리할 것 (2026-09-14, 와이어프레임 1a)
 *
 * 전에는 이 화면 하나에 「현황」탭과 「처리할 것」탭이 같이 있었다(073). 사건
 * 분석 화면의 검토/인사이트 분리를 사고보고서·리콜 목록에도 적용하면서
 * URL 자체로 나눴다 — 이 페이지가 기본(할 일: 올리기·찾기·행별 작업)이고,
 * 집계·설명 같은 읽기 전용 자료는 `/accidents/status` 로 옮겼다. 두 페이지가
 * 쓰는 조회는 `./data.ts` 에 한 벌만 둔다(CLAUDE.md §9).
 *
 * 게시판 형태인 이유 (담당자 요청)
 *   건수가 늘면 전부 한 화면에 쏟을 수 없다. 찾기·정렬·쪽 넘김을 붙였다.
 *   상태는 전부 주소줄에 있어서 주소를 복사해 동료에게 보낼 수 있다.
 */
export default async function AccidentsPage({
  searchParams,
}: {
  searchParams: Promise<BoardParams & { done?: string }>;
}) {
  const params = await searchParams;
  const { done } = params;

  let data: Awaited<ReturnType<typeof load>> | null = null;
  let error: string | null = null;
  try {
    data = await load(params);
  } catch (e) {
    console.error('사고보고서 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="2 · 사고보고서"
        title="사고보고서와 안전기준 연계 분석"
        lead="PDF를 올리고 원문을 확인하면, 사고와 관련될 수 있는 안전기준 조항을 찾습니다."
        /* 여섯 걸음의 이름과 뜻은 UPLOAD_STEPS 에 한 벌만 둔다 */
        workflow={data ? [
          { label: '올리기', who: '사람', href: '#accidents-upload', note: `${data.summary.files}건`, state: 'done' },
          {
            label: '글자·개인정보 검사',
            note: data.summary.fileErrors > 0 ? `막힘 ${data.summary.fileErrors}` : '이상 없음',
            state: data.summary.fileErrors > 0 ? 'here' : 'done',
          },
          {
            label: '원문 확인',
            who: '사람',
            note: `${data.summary.confirmed} / ${data.summary.cases}`,
            state: data.summary.confirmed < data.summary.cases ? 'here' : 'done',
          },
          {
            label: '코드·검색 준비',
            note: `${data.summary.embedded} / ${data.summary.cases}`,
            state: data.summary.embedded < data.summary.cases ? 'here' : 'done',
          },
          {
            label: '분석',
            who: '사람',
            note: `${data.summary.analyzed} / ${data.summary.confirmed}`,
            state: data.summary.analyzed < data.summary.confirmed ? 'here' : 'done',
          },
          {
            label: '검수·채택',
            who: '사람',
            href: '#accidents-list',
            note: `채택 ${data.summary.adopted}`,
            state: 'todo',
          },
        ] : undefined}
      />

      <ScreenSwitch
        options={[
          { href: '/accidents', label: '처리할 것' },
          { href: '/accidents/status', label: '현황' },
        ]}
      />

      <DoneBanner message={done} />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          <details id="accidents-upload" className="mt-8 scroll-mt-8 border border-rule bg-surface px-5 py-4">
            <summary className="cursor-pointer text-[13px] font-medium">
              사고보고서 올리기
            </summary>
            <div className="mt-3">
              <p className="text-[12px] leading-relaxed text-ink-3">
                여러 건을 한 번에 올릴 수 있습니다. 한 건이 실패해도 나머지는 계속 처리합니다.
                같은 파일을 다시 올리면 건너뜁니다. 주민등록번호·연락처처럼 개인정보로 보이는
                값이 발견되면 그 파일은 AI 처리로 넘기지 않습니다.
              </p>
              <div className="mt-3">
                <ActionForm
                  action={uploadAccidentPdfs}
                  label="올리기"
                  pendingLabel="올리는 중…"
                  className="border border-measure bg-measure px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
                >
                  <input
                    id="files" name="files" type="file" accept="application/pdf" multiple required
                    className="text-[12px] file:mr-3 file:border file:border-rule file:bg-paper file:px-3 file:py-1.5 file:text-[12px] file:text-ink"
                  />
                </ActionForm>
              </div>
            </div>
          </details>

          <BoardToolbar
            basePath="/accidents"
            params={params}
            placeholder="파일명·제목·본문으로 찾기"
            filters={[{
              name: 'status',
              label: '진행',
              options: Object.entries(FILE_STATUS_LABEL).map(([value, label]) => ({ value, label })),
            }]}
          />

          {/* 대분류 — 담당자는 대개 한 대분류만 맡는다(2026-09-09) */}
          <BoardTabs
            basePath="/accidents"
            params={params}
            name="group"
            options={GROUP_ORDER.map((g) => ({
              value: g,
              label: `${g} ${(data.groupCount.get(g) ?? 0).toLocaleString()}`,
            }))}
          />

          {data.total === 0 ? (
            <EmptyState
              message={
                params.q || params.status
                  ? '조건에 맞는 사고보고서가 없습니다. 찾기 조건을 지워 보세요.'
                  : '아직 올린 사고보고서가 없습니다. 위 「사고보고서 올리기」를 펼쳐 시작하세요.'
              }
            />
          ) : (
            <section id="accidents-list" className="mt-6 scroll-mt-8">
              <div className="label grid grid-cols-[1fr_auto_auto] gap-3 border-b border-rule pb-2">
                <SortHeader basePath="/accidents" params={params} field="filename" label="사고보고서" />
                <SortHeader basePath="/accidents" params={params} field="status" label="진행" />
                <SortHeader basePath="/accidents" params={params} field="uploaded_at" label="올린 날짜" align="right" />
              </div>

              {data.rows.map((r) => (
                <article key={r.id} className="border-b border-rule py-3.5">
                  <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3">
                    <span className="text-[13px] font-medium">{r.filename}</span>
                    <span className={`text-[11px] ${r.status === 'error' ? 'text-halt' : 'text-ink-3'}`}>
                      {FILE_STATUS_LABEL[r.status] ?? r.status}
                    </span>
                    <span className="addr tnum text-right text-[11px] text-ink-3">
                      {when(r.uploaded_at)}
                    </span>
                  </div>

                  <div className="addr tnum mt-1 text-[11px] text-ink-3">
                    <span className={r.item_group ? 'text-ink-2' : 'text-ink-3'}>
                      {r.item_group ?? '기타'}
                    </span>
                    {' · '}
                    {r.page_count ?? '—'}쪽 · 뽑아낸 글자 {(r.extracted_chars ?? 0).toLocaleString()}자
                    {/*
                      원본 미보관은 이제 중립적인 상태가 아니다 (02 설계서 §3.3)

                      사고보고서는 개인정보 때문에 저장소에 두지 않으므로 Storage 가
                      유일한 원본 보관처다. 원본이 없으면 조항 결과에서 원문 페이지로
                      되짚을 수 없다 — 이 체계가 지키기로 한 것이 그 되짚기다.
                      지금은 보관에 실패하면 사건을 만들지 않지만, 그 전에 들어온
                      자료 중에는 원본 없이 분석까지 간 것이 남아 있을 수 있다.
                    */}
                    {r.storage_path ? (
                      ' · 원본 보관됨'
                    ) : (
                      <span className="text-caution"> · 원본 미보관 — 원문 역추적 불가</span>
                    )}
                    {r.tag_count > 0 && ` · 위해요인 코드 ${r.tag_count}`}
                    {r.embedded
                      ? ' · 의미 검색 준비됨'
                      : r.embedding_pending
                        ? ' · 의미 검색 준비 중…'
                        : ''}
                  </div>

                  {/*
                    파일마다 「지금 몇 번째 걸음이고 다음에 무엇을 해야 하는가」
                    (담당자 요청, 2026-09-09). 상태 낱말만 흩어져 있으면 처음 쓰는
                    사람은 다음 동작을 못 찾는다.
                  */}
                  {(() => {
                    const st = stepOf(r);
                    return (
                      <div
                        className={`mt-2 border-l-2 px-3 py-1.5 text-[12px] leading-relaxed ${
                          st.blocked ? 'border-halt bg-halt-soft text-ink-2' : 'border-rule bg-surface text-ink-2'
                        }`}
                      >
                        <span className="addr text-[11px] text-ink-3">
                          {st.step}/6 {UPLOAD_STEPS[st.step - 1].name}
                        </span>
                        <span className="ml-2">{st.next}</span>
                      </div>
                    );
                  })()}

                  {r.error_reason && (
                    <p className="mt-2 border-l-2 border-halt bg-halt-soft px-3 py-2 text-[12px] leading-relaxed text-ink-2">
                      {r.error_reason}
                    </p>
                  )}

                  {r.preview && (
                    <details className="mt-2.5">
                      <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink">
                        뽑아낸 원문 확인
                      </summary>
                      <pre className="mt-1.5 max-h-56 overflow-auto border border-rule bg-surface px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
                        {r.preview}
                      </pre>
                    </details>
                  )}

                  {r.case_id && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-3">
                      {r.is_confirmed ? (
                        <>
                          <span className="text-[12px] text-measure">원문 확인함</span>
                          <Link
                            href={`/analysis/${r.case_id}`}
                            className="text-[12px] text-measure underline underline-offset-2"
                          >
                            분석 상세보기
                          </Link>
                          <ActionForm
                            action={runAnalysisAction}
                            hidden={{ caseId: r.case_id }}
                            label={r.run_count > 0 ? '분석 다시 실행' : '분석 실행'}
                            pendingLabel="분석하는 중…"
                            className="border border-rule px-3 py-1.5 text-[12px] hover:bg-measure-soft"
                          />
                          <span className="addr tnum text-[11px] text-ink-3">
                            {r.run_count > 0
                              ? `관련 조항 후보 ${r.last_results ?? 0}건${r.adopted > 0 ? ` · 채택 ${r.adopted}` : ''}`
                              : '아직 분석하지 않음'}
                          </span>
                        </>
                      ) : (
                        <>
                          <ActionForm
                            action={confirmCase}
                            hidden={{ caseId: r.case_id }}
                            label="원문을 확인했습니다 — 분석 대상으로"
                            pendingLabel="처리하는 중…"
                            className="border border-rule px-3 py-1.5 text-[12px] hover:bg-rule-soft"
                          />
                          <span className="text-[11px] text-ink-3">
                            위 「뽑아낸 원문 확인」을 펼쳐 표가 뭉개지지 않았는지 보고 눌러 주세요
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </article>
              ))}

              <BoardPager
                basePath="/accidents" params={params}
                total={data.total} page={data.page} per={data.per}
              />
            </section>
          )}
        </>
      )}

      <TermsNote />
      <PageToc items={ACCIDENTS_TOC} />
    </div>
  );
}
