import { getDb } from '@/lib/db';
import { PageHead, ConnectionError } from '@/components/Panel';
import { runEmbedTick, retryParked, sendTestAlert } from './actions';

export const dynamic = 'force-dynamic';

/**
 * 운영 — 담당자가 시스템을 관리하는 자리
 *
 * 왼쪽 레일의 1~4 는 자료가 흐르는 순서(적재 → 코드 → 사건 → 분석)다. 이 화면은
 * 그 흐름 위에 있지 않다. "흐름이 지금 제대로 돌고 있는가"를 보는 자리라서
 * 번호를 붙이지 않고 레일 아래쪽에 따로 뒀다.
 *
 * 이 화면이 답해야 하는 질문은 넷이다.
 *   1. 자동으로 도는 것들이 지금 돌고 있는가
 *   2. 사람이 봐야 할 문제가 있는가
 *   3. 문제가 생기면 어떻게 연락이 오는가
 *   4. 이 사이트에 누가 들어올 수 있는가 (ID/PW)
 *
 * 왜 한 화면에 모으는가
 *   이 정보들은 그동안 서로 다른 곳에 흩어져 있었다 — 임베딩 상태는 터미널
 *   명령(npm run embed:status), 접속 비밀번호는 Netlify 대시보드, 오류는 아무 데도.
 *   담당자가 코드를 읽지 않는 사람이라면 그중 어느 것도 볼 수 없다. 그래서 모은다.
 */

interface OpsStatus {
  parked: number;
  failed: number;
  in_flight: number;
  cron_failed_24h: number;
  embedding_models: number;
  telegram_configured: boolean;
  openai_configured: boolean;
  last_alert_at: string | null;
}

interface EmbedRow {
  target_table: string;
  total: number;
  embedded: number;
  pending: number;
  models: number;
  in_flight: number;
  failed: number;
  parked: number;
}

interface JobRow {
  jobname: string;
  schedule: string;
  active: boolean;
  last_status: string | null;
  last_at: string | null;
  last_message: string | null;
}

interface ParkedRow {
  target_table: string;
  row_id: number;
  attempts: number;
  last_error: string | null;
  settled_at: string | null;
}

interface AlertRow {
  kind: string;
  body: string;
  status_code: number | null;
  sent_at: string;
}

interface Data {
  ops: OpsStatus;
  embed: EmbedRow[];
  jobs: JobRow[];
  parkedRows: ParkedRow[];
  cronFailures: { jobname: string; end_time: string; message: string | null }[];
  alerts: AlertRow[];
}

async function load(): Promise<{ data: Data | null; error: string | null }> {
  try {
    const db = getDb();

    const [ops] = await db<OpsStatus[]>`select * from public.ops_status`;
    const embed = await db<EmbedRow[]>`select * from public.embed_status order by target_table`;

    const jobs = await db<JobRow[]>`
      select j.jobname, j.schedule, j.active,
             d.status  as last_status,
             d.end_time::text as last_at,
             d.return_message as last_message
      from cron.job j
      left join lateral (
        select status, end_time, return_message from cron.job_run_details
        where jobid = j.jobid order by start_time desc limit 1
      ) d on true
      order by j.jobname
    `;

    const parkedRows = await db<ParkedRow[]>`
      select target_table, row_id, attempts, last_error, settled_at::text
      from public.embed_queue
      where status = 'failed' and attempts >= 5
      order by target_table, row_id limit 20
    `;

    const cronFailures = await db<{ jobname: string; end_time: string; message: string | null }[]>`
      select j.jobname, d.end_time::text, d.return_message as message
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where d.status = 'failed' and d.end_time > now() - interval '24 hours'
      order by d.end_time desc limit 10
    `;

    const alerts = await db<AlertRow[]>`
      select kind, body, status_code, sent_at::text
      from public.ops_alert order by sent_at desc limit 8
    `;

    return { data: { ops, embed, jobs, parkedRows, cronFailures, alerts }, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 상태 한 줄. 색은 계측의 색을 따르되, 시스템 실패에만 적색을 쓴다(globals.css) */
function Signal({
  label, value, level, note,
}: {
  label: string;
  value: string;
  level: 'ok' | 'caution' | 'halt';
  note?: string;
}) {
  const tone =
    level === 'halt' ? 'text-halt' : level === 'caution' ? 'text-caution' : 'text-measure';
  const dot =
    level === 'halt' ? 'bg-halt' : level === 'caution' ? 'bg-caution' : 'bg-measure';
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

function Section({
  title, lead, children,
}: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {lead && <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-ink-2">{lead}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Cmd({ children, note }: { children: string; note?: string }) {
  return (
    <li className="border-t border-rule py-2.5 text-[13px]">
      <code className="addr text-ink">{children}</code>
      {note && <div className="mt-0.5 text-[11px] leading-snug text-ink-3">{note}</div>}
    </li>
  );
}

function when(iso: string | null): string {
  if (!iso) return '기록 없음';
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const { done } = await searchParams;
  const { data, error } = await load();

  // 미들웨어가 읽는 값과 같은 환경변수를 본다. 값 자체는 절대 화면에 내지 않는다.
  const authUser = process.env.SITE_AUTH_USERNAME?.trim() ?? '';
  const authPassSet = Boolean(process.env.SITE_AUTH_PASSWORD?.trim());

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
      <PageHead
        label="운영"
        title="시스템이 지금 제대로 돌고 있는가"
        lead="자동으로 도는 작업들의 상태, 사람이 봐야 할 문제, 알림과 접속 관리를 한자리에 모았습니다. 평소에는 볼 일이 없어야 정상입니다."
      />

      {done && (
        <div className="mt-6 border-l-2 border-measure bg-measure-soft px-4 py-3 text-[13px] text-ink-2">
          {done}
        </div>
      )}

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          {/* ── 1. 한눈에 ─────────────────────────────────────────── */}
          <Section
            title="지금 상태"
            lead="네 가지가 모두 초록이면 손댈 것이 없습니다."
          >
            <div className="grid gap-x-8 sm:grid-cols-2">
              <Signal
                label="임베딩 자동 배치"
                level={
                  data.ops.parked > 0 ? 'halt' : data.ops.in_flight > 0 ? 'caution' : 'ok'
                }
                value={
                  data.ops.parked > 0
                    ? `보류 ${data.ops.parked}건 — 확인 필요`
                    : data.ops.in_flight > 0
                      ? `처리 중 ${data.ops.in_flight}건`
                      : '정상 — 밀린 것 없음'
                }
                note="1분마다 임베딩이 빈 자료를 찾아 채웁니다"
              />
              <Signal
                label="배치 실행"
                level={data.ops.cron_failed_24h > 0 ? 'halt' : 'ok'}
                value={
                  data.ops.cron_failed_24h > 0
                    ? `최근 24시간 ${data.ops.cron_failed_24h}회 실패`
                    : '정상 — 최근 24시간 실패 없음'
                }
                note="배치 자체가 죽으면 아무것도 갱신되지 않습니다"
              />
              <Signal
                label="임베딩 좌표계"
                level={data.ops.embedding_models > 1 ? 'halt' : 'ok'}
                value={
                  data.ops.embedding_models > 1
                    ? `모델 ${data.ops.embedding_models}종 혼재 — 검색을 믿을 수 없음`
                    : '정상 — 단일 모델'
                }
                note="모델이 섞이면 오류 없이 검색 품질만 조용히 떨어집니다"
              />
              <Signal
                label="문제 알림"
                level={data.ops.telegram_configured ? 'ok' : 'caution'}
                value={
                  data.ops.telegram_configured
                    ? '설정됨 — 텔레그램으로 보냅니다'
                    : '설정 안 됨 — 문제가 생겨도 연락이 가지 않습니다'
                }
                note={
                  data.ops.last_alert_at
                    ? `마지막 발송 ${when(data.ops.last_alert_at)}`
                    : '아직 보낸 알림이 없습니다'
                }
              />
            </div>
          </Section>

          {/* ── 2. 사람이 봐야 할 것 ──────────────────────────────── */}
          {(data.parkedRows.length > 0 || data.cronFailures.length > 0) && (
            <Section
              title="확인이 필요한 것"
              lead="자동으로 풀리지 않아 사람의 판단이 필요한 항목입니다."
            >
              {data.parkedRows.length > 0 && (
                <div className="border border-halt bg-halt-soft px-4 py-3">
                  <div className="text-[13px] font-semibold text-halt">
                    임베딩 보류 {data.parkedRows.length}건
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
                    5회 시도해도 임베딩이 만들어지지 않았습니다. 원인을 고친 뒤 아래
                    「보류 건 다시 시도」를 누르세요. 그때까지 이 자료는 의미검색에 잡히지
                    않습니다.
                  </p>
                  <ul className="mt-3">
                    {data.parkedRows.map((p) => (
                      <li
                        key={`${p.target_table}-${p.row_id}`}
                        className="border-t border-halt/20 py-2 text-[12px]"
                      >
                        <span className="addr text-ink">
                          {p.target_table} #{p.row_id}
                        </span>
                        <span className="ml-2 text-ink-3">{p.attempts}회 시도</span>
                        {p.last_error && (
                          <div className="mt-0.5 leading-snug text-ink-2">{p.last_error}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.cronFailures.length > 0 && (
                <div className="mt-4 border border-halt bg-halt-soft px-4 py-3">
                  <div className="text-[13px] font-semibold text-halt">
                    배치 실행 실패 {data.cronFailures.length}건 (최근 24시간)
                  </div>
                  <ul className="mt-2">
                    {data.cronFailures.map((f, i) => (
                      <li key={i} className="border-t border-halt/20 py-2 text-[12px]">
                        <span className="addr text-ink">{f.jobname}</span>
                        <span className="ml-2 text-ink-3">{when(f.end_time)}</span>
                        {f.message && (
                          <div className="mt-0.5 leading-snug text-ink-2">{f.message}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Section>
          )}

          {/* ── 3. 조작 ───────────────────────────────────────────── */}
          <Section
            title="지금 하기"
            lead="셋 다 여러 번 눌러도 안전합니다. 자동으로 일어날 일을 앞당길 뿐입니다."
          >
            <div className="flex flex-wrap gap-3">
              <form action={runEmbedTick}>
                <button
                  type="submit"
                  className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-measure-soft"
                >
                  임베딩 배치 지금 실행
                </button>
              </form>
              <form action={sendTestAlert}>
                <button
                  type="submit"
                  className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-measure-soft"
                >
                  시험 알림 보내기
                </button>
              </form>
              {data.ops.parked > 0 && (
                <form action={retryParked}>
                  <button
                    type="submit"
                    className="border border-halt bg-surface px-4 py-2 text-[13px] text-halt hover:bg-halt-soft"
                  >
                    보류 {data.ops.parked}건 다시 시도
                  </button>
                </form>
              )}
            </div>
          </Section>

          {/* ── 4. 자동 배치 상세 ─────────────────────────────────── */}
          <Section
            title="자동으로 도는 작업"
            lead="DB 안에서 스스로 돕니다. 사이트가 꺼져 있어도 돌아갑니다."
          >
            <div className="label grid grid-cols-[1fr_auto_auto_1fr] gap-3 pb-2">
              <span>작업</span>
              <span>주기</span>
              <span className="text-right">마지막</span>
              <span className="text-right">결과</span>
            </div>
            {data.jobs.map((j) => (
              <div
                key={j.jobname}
                className="grid grid-cols-[1fr_auto_auto_1fr] items-baseline gap-3 border-t border-rule py-2.5"
              >
                <div className="min-w-0">
                  <div className="addr truncate text-[12px]">{j.jobname}</div>
                  <div className="text-[11px] text-ink-3">
                    {j.jobname === 'embed-tick' && '임베딩이 빈 자료를 채운다'}
                    {j.jobname === 'ops-watch' && '문제를 찾아 알림을 보낸다'}
                    {j.jobname === 'cron-log-prune' && '30일 지난 실행 기록을 지운다'}
                  </div>
                </div>
                <span className="addr text-[11px] text-ink-3">{j.schedule}</span>
                <span className="addr tnum text-right text-[11px] text-ink-3">
                  {when(j.last_at)}
                </span>
                <span
                  className={`truncate text-right text-[11px] ${
                    j.last_status === 'failed' ? 'text-halt' : 'text-ink-2'
                  }`}
                >
                  {!j.active && <span className="text-halt">비활성 </span>}
                  {j.last_message ?? j.last_status ?? '—'}
                </span>
              </div>
            ))}

            <div className="label mt-8 grid grid-cols-[1fr_repeat(4,minmax(48px,auto))] gap-3 pb-2">
              <span>자료</span>
              <span className="text-right">전체</span>
              <span className="text-right">완료</span>
              <span className="text-right">대기</span>
              <span className="text-right">보류</span>
            </div>
            {data.embed.map((e) => (
              <div
                key={e.target_table}
                className="grid grid-cols-[1fr_repeat(4,minmax(48px,auto))] items-baseline gap-3 border-t border-rule py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">
                    {e.target_table === 'clause' ? '안전기준 조항' : '사건 (사고·리콜)'}
                  </div>
                  <div className="text-[11px] text-ink-3">
                    {e.total - e.embedded > 0 && e.pending === 0
                      ? `${(e.total - e.embedded).toLocaleString()}건은 아직 코드화 전이라 임베딩 대상이 아닙니다`
                      : '임베딩 대상 전부 처리됨'}
                  </div>
                </div>
                <span className="addr tnum text-right text-[13px] text-ink-2">
                  {e.total.toLocaleString()}
                </span>
                <span className="addr tnum text-right text-[13px]">
                  {e.embedded.toLocaleString()}
                </span>
                <span
                  className={`addr tnum text-right text-[13px] ${e.pending ? 'text-caution' : 'text-ink-3'}`}
                >
                  {e.pending}
                </span>
                <span
                  className={`addr tnum text-right text-[13px] ${e.parked ? 'text-halt' : 'text-ink-3'}`}
                >
                  {e.parked}
                </span>
              </div>
            ))}
          </Section>

          {/* ── 5. 알림 ───────────────────────────────────────────── */}
          <Section
            title="문제 알림 (텔레그램)"
            lead="세 가지만 알립니다 — 임베딩 보류, 배치 실행 실패, 임베딩 모델 혼재. 알림이 시끄러우면 아무도 읽지 않기 때문에 일부러 짧게 뒀습니다."
          >
            {!data.ops.telegram_configured ? (
              <div className="border border-caution bg-caution-soft px-4 py-3">
                <div className="text-[13px] font-semibold text-caution">
                  아직 설정되지 않았습니다
                </div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                  지금은 문제가 생겨도 연락이 가지 않습니다. 화면을 열어야만 알 수 있습니다.
                  설정하려면 두 단계가 필요합니다.
                </p>
                <ol className="mt-3 space-y-2 text-[12px] text-ink-2">
                  <li>
                    <span className="text-ink">1.</span> 텔레그램 <span className="addr">@BotFather</span>{' '}
                    에서 봇을 만들고 토큰을 받습니다. 이미 n8n 에서 쓰는 봇이 있다면 그
                    자격증명의 토큰과 같은 값입니다.
                  </li>
                  <li>
                    <span className="text-ink">2.</span> <code className="addr text-ink">.env.local</code>{' '}
                    에 <code className="addr text-ink">TELEGRAM_BOT_TOKEN</code> 을 넣고{' '}
                    <code className="addr text-ink">npm run ops:secret</code> 을 한 번 실행합니다.
                  </li>
                </ol>
                <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
                  토큰은 저장소에 올라가지 않습니다. DB 안의 금고(Supabase Vault)에 넣어
                  두고, 알림을 보내는 순간에만 꺼내 씁니다. 알림을 DB 에서 보내는 이유는
                  문제가 DB 안에서 생기기 때문입니다 — 사이트를 아무도 안 보고 있어도
                  연락이 가야 합니다.
                </p>
              </div>
            ) : (
              <p className="text-[12px] text-ink-2">
                설정되어 있습니다. 대화 번호와 토큰은 DB 금고에 있고 화면에는 표시하지
                않습니다. 바꾸려면 <code className="addr text-ink">.env.local</code> 을 고치고{' '}
                <code className="addr text-ink">npm run ops:secret</code> 을 다시 실행하세요.
              </p>
            )}

            {data.alerts.length > 0 && (
              <>
                <div className="label mt-6 pb-2">최근 발송</div>
                {data.alerts.map((a, i) => (
                  <div key={i} className="border-t border-rule py-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <span className="text-[13px] font-medium">{a.kind}</span>
                      <span className="addr tnum text-[11px] text-ink-3">
                        {when(a.sent_at)}
                        {a.status_code === 200 ? (
                          <span className="ml-2 text-measure">전달됨</span>
                        ) : a.status_code == null ? (
                          <span className="ml-2 text-ink-3">확인 중</span>
                        ) : (
                          <span className="ml-2 text-halt">실패 {a.status_code}</span>
                        )}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] leading-snug whitespace-pre-line text-ink-3">
                      {a.body.slice(0, 200)}
                    </div>
                  </div>
                ))}
              </>
            )}
          </Section>

          {/* ── 6. 접속 관리 ──────────────────────────────────────── */}
          <Section
            title="사이트 접속 관리 (ID · 비밀번호)"
            lead="이 사이트는 주소만 알면 누구나 들어올 수 있는 곳에 있습니다. 그래서 앞단에 ID/비밀번호를 두고 외부 접근을 막습니다."
          >
            <div className="grid gap-x-8 sm:grid-cols-2">
              <Signal
                label="현재 잠금 상태"
                level={authPassSet ? 'ok' : 'halt'}
                value={authPassSet ? '잠겨 있음' : '열려 있음 — 누구나 접근 가능'}
                note={
                  authPassSet
                    ? '비밀번호가 설정되어 있어 로그인 창이 뜹니다'
                    : 'SITE_AUTH_PASSWORD 가 비어 있으면 미들웨어가 그냥 통과시킵니다'
                }
              />
              <Signal
                label="사용자이름 검사"
                level={authUser ? 'ok' : 'caution'}
                value={authUser ? `"${authUser}" 만 허용` : '검사하지 않음 — 아무 값이나 통과'}
                note="SITE_AUTH_USERNAME 을 비워 두면 비밀번호만 맞으면 들어옵니다"
              />
            </div>

            <div className="mt-6 border-t border-rule pt-5">
              <div className="label">바꾸는 방법</div>
              <ol className="mt-3 space-y-3 text-[12px] leading-relaxed text-ink-2">
                <li>
                  <span className="text-ink">1.</span> Netlify 대시보드 →{' '}
                  <span className="text-ink">Site configuration → Environment variables</span>{' '}
                  에서 <code className="addr text-ink">SITE_AUTH_PASSWORD</code> (필요하면{' '}
                  <code className="addr text-ink">SITE_AUTH_USERNAME</code> 도) 값을 고칩니다.
                </li>
                <li>
                  <span className="text-ink">2.</span> 저장한 뒤{' '}
                  <span className="text-ink">반드시 재배포</span>합니다. 환경변수만 바꾸면
                  반영되지 않습니다.
                </li>
              </ol>
            </div>

            <div className="mt-5 border border-caution bg-caution-soft px-4 py-3">
              <div className="label text-caution">실제로 겪은 함정 두 가지</div>
              <ul className="mt-2 space-y-2 text-[12px] leading-relaxed text-ink-2">
                <li>
                  <span className="text-ink">「secret」로 표시해 등록하지 마세요.</span> 그렇게
                  등록한 값이 저장됐다는 응답만 오고 실제로는 저장되지 않은 적이 있습니다.
                  그 결과 로그인 창이 아예 안 뜨고 사이트가 열린 채로 있었습니다. 일반
                  변수로 등록하면 정상 저장됩니다.
                </li>
                <li>
                  <span className="text-ink">환경변수만 바꾸면 반영되지 않습니다.</span> 값은
                  배포 시점에 고정되어 이미 떠 있는 함수에는 적용되지 않습니다. 코드 변경이
                  없더라도 빈 커밋(<code className="addr">git commit --allow-empty</code>)으로
                  재배포를 한 번 일으켜야 합니다.
                </li>
              </ul>
            </div>

            <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
              이 화면은 비밀번호 값 자체를 표시하지 않습니다. 설정되어 있는지 여부만
              확인합니다. 로컬 개발에서는{' '}
              <code className="addr">SITE_AUTH_PASSWORD</code> 를 비워 두면 로그인 없이
              열립니다.
            </p>
          </Section>

          {/* ── 7. 명령어 ─────────────────────────────────────────── */}
          <Section
            title="자주 쓰는 명령어"
            lead="터미널에서 실행합니다. 화면으로 되는 일은 위에 버튼으로 뒀으니, 여기 있는 것들은 자료를 새로 넣거나 크게 바꿀 때만 씁니다."
          >
            <ul>
              <Cmd note="자동 배치 상태를 터미널에서 확인합니다 (이 화면과 같은 내용)">
                npm run embed:status
              </Cmd>
              <Cmd note="텔레그램 봇 토큰을 DB 금고에 넣습니다. .env.local 을 고친 뒤 실행">
                npm run ops:secret
              </Cmd>
              <Cmd note="OpenAI 키를 바꿨을 때 DB 금고에 다시 넣습니다">
                npm run embed:secret
              </Cmd>
              <Cmd note="텔레그램으로 시험 알림을 보냅니다 (위 버튼과 같은 일)">
                npm run ops:test
              </Cmd>
              <Cmd note="대량으로 임베딩을 만듭니다. 자동 배치보다 훨씬 빠릅니다">
                npm run embed
              </Cmd>
              <Cmd note="조항에 위해요인 코드를 붙입니다. LLM 비용이 드는 작업입니다">
                npm run tag
              </Cmd>
              <Cmd note="새 마이그레이션을 DB 에 적용합니다">npm run db:push</Cmd>
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}
