import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, TermsNote } from '@/components/Panel';
import { ActionForm } from '@/components/ActionForm';
import { AutoRefresh } from '@/components/AutoRefresh';
import { PageToc, type TocItem } from '@/components/PageToc';
import {
  runEmbedTick, retryParked, sendTestAlert,
  sendCustomMessage, runJobNow, toggleAutoTagging,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * 운영 — 담당자가 시스템을 관리하는 자리
 *
 * 왼쪽 레일의 1~3 은 자료가 흐르는 순서다. 이 화면은 그 흐름 위에 있지 않다.
 * "흐름이 지금 제대로 돌고 있는가"를 보는 자리다.
 *
 * 이 화면이 답해야 하는 질문
 *   1. 자동으로 도는 것들이 지금 돌고 있는가
 *   2. 최근에 무엇이 언제 돌아 무엇을 했는가
 *   3. 사람이 봐야 할 문제가 있는가
 *   4. 문제가 생기면 어떻게 연락이 오는가
 *   5. 이 사이트에 누가 들어올 수 있는가
 *
 * 말을 담당자의 말로 바꿨다 (2026-09-03)
 *   "임베딩" → 의미 검색 준비 / "배치" → 자동 작업 / "임베딩 좌표계" → 의미 검색 기준
 *   "DB 금고" → 비밀값 보관함. 뜻이 달라진 것은 없고 부르는 이름만 바꿨다.
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

interface RunRow {
  job: string;
  started_at: string;
  status_code: number | null;
  response: string | null;
}

interface Data {
  ops: OpsStatus;
  embed: EmbedRow[];
  jobs: JobRow[];
  runs: RunRow[];
  parkedRows: { target_table: string; row_id: number; attempts: number; last_error: string | null }[];
  cronFailures: { jobname: string; end_time: string; message: string | null }[];
  alerts: { kind: string; body: string; status_code: number | null; sent_at: string }[];
  taggable: number;
  autoTagging: boolean;
  embeddedToday: number;
  jobsConfigured: boolean;
}

/** 자료 종류 이름 — 담당자 지적으로 "사건"을 사고보고서·리콜로 나눴다 */
const TARGET_LABEL: Record<string, string> = {
  clause: '안전기준 조항',
  accident: '사고보고서',
  recall: '리콜',
};

/** 자동 작업이 하는 일을 한 줄로 */
const JOB_PURPOSE: Record<string, string> = {
  'embed-tick': '의미 검색 준비가 안 된 자료를 찾아 준비한다',
  'ops-watch': '문제를 찾아 알림을 보낸다',
  'cron-log-prune': '30일 지난 실행 기록을 지운다',
  'job-recalls-fetch': '새 리콜을 가져온다',
  'job-standards-sync': '안전기준 폴더에 새 문서가 있는지 본다',
  'job-tag-chunk': '위해요인 코드를 이어서 부여한다 (켜 뒀을 때만)',
};

const RUN_LABEL: Record<string, string> = {
  'recalls-fetch': '리콜 수집',
  'standards-sync': '안전기준 동기화',
  'tag-chunk': '위해요인 코드 부여',
};

const OPS_TOC: TocItem[] = [
  { id: 'ops-status', label: '지금 상태' },
  { id: 'ops-recent', label: '최근 처리' },
  { id: 'ops-attention', label: '확인이 필요한 것' },
  { id: 'ops-actions', label: '지금 하기' },
  { id: 'ops-details', label: '자동으로 도는 일' },
  { id: 'ops-alerts', label: '알림' },
  { id: 'ops-access', label: '접속 관리' },
];

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

    const runs = await db<RunRow[]>`
      select job, started_at::text, status_code, response
      from public.job_run order by started_at desc limit 8
    `;

    const parkedRows = await db<Data['parkedRows']>`
      select target_table, row_id, attempts, last_error
      from public.embed_queue
      where status = 'failed' and attempts >= 5
      order by target_table, row_id limit 20
    `;

    const cronFailures = await db<Data['cronFailures']>`
      select j.jobname, d.end_time::text, d.return_message as message
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where d.status = 'failed' and d.end_time > now() - interval '24 hours'
      order by d.end_time desc limit 10
    `;

    const alerts = await db<Data['alerts']>`
      select kind, body, status_code, sent_at::text
      from public.ops_alert order by sent_at desc limit 8
    `;

    // 코드를 붙일 수 있는데 아직 안 붙은 요건 조항 — 화면이 남은 일과 비용을 보여 준다
    const [t] = await db<{ n: number }[]>`
      select count(*)::int as n
      from public.clause c join public.standard s on s.id = c.standard_id
      where s.is_current and c.clause_role = 'REQUIREMENT'
        and length(btrim(c.body)) >= 15
        and not exists (select 1 from public.clause_tag ct where ct.clause_id = c.id)
    `;

    const [e] = await db<{ n: number }[]>`
      select count(*)::int as n from public.clause where embedded_at > now() - interval '24 hours'
    `;

    const [at] = await db<{ on: boolean }[]>`select public.auto_tagging_on() as on`;

    const [j] = await db<{ ok: boolean }[]>`
      select (exists (select 1 from vault.decrypted_secrets where name = 'jobs_token')
              and exists (select 1 from vault.decrypted_secrets where name = 'site_base_url')) as ok
    `;

    return {
      data: {
        ops, embed, jobs, runs, parkedRows, cronFailures, alerts,
        taggable: t.n, autoTagging: at.on, embeddedToday: e.n, jobsConfigured: j.ok,
      },
      error: null,
    };
  } catch (e) {
    console.error('운영 화면 조회 실패:', e);
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function Signal({
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

function Section({
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

function when(iso: string | null): string {
  if (!iso) return '기록 없음';
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

/** 라우트가 돌려준 JSON 요약을 사람이 읽을 문장으로 */
function describeRun(r: RunRow): string {
  if (r.status_code == null) return '결과를 기다리는 중';
  if (r.status_code !== 200) return `실패 (HTTP ${r.status_code}) ${(r.response ?? '').slice(0, 120)}`;
  try {
    const j = JSON.parse(r.response ?? '{}');
    if (r.job === 'recalls-fetch') {
      return `조회 ${j.received ?? 0}건 · 새로 들어옴 ${j.newCase ?? 0}건 · 코드 부여 ${j.tagged ?? 0}건`;
    }
    if (r.job === 'standards-sync') {
      return `새 기준 ${j.added ?? 0}건 · 개정 ${j.updated ?? 0}건 (전체 ${j.total ?? 0}건 확인)`;
    }
    return `코드 부여 ${j.done ?? 0}건 · 남은 조항 ${j.remaining ?? 0}건`;
  } catch {
    return (r.response ?? '').slice(0, 120);
  }
}

export default async function OpsPage() {
  const { data, error } = await load();

  const authUser = process.env.SITE_AUTH_USERNAME?.trim() ?? '';
  const authPassSet = Boolean(process.env.SITE_AUTH_PASSWORD?.trim());

  // 실측 단가 — 조항 1건당 약 $0.0022 (라운드 9)
  const tagCost = data ? (data.taggable * 0.0022).toFixed(2) : '0';
  // 예상 시간은 넉넉하게 잡는다.
  //
  // 실측은 동시 4건에서 1건당 4.75초였다(12건 57초). 자동 실행은 동시 8건이라 더
  // 빠를 것으로 보이지만 그 수치는 재 보지 않았고, 요청 한도에 걸리면 오히려
  // 느려질 수도 있다. 재 본 값으로만 계산해 "생각보다 오래 걸린다"는 실망이
  // 생기지 않게 한다. 1분 주기 중 25초만 쓰므로 실제 경과 시간은 그만큼 늘어난다.
  const tagHours = data ? Math.max(1, Math.round((data.taggable * 4.75 * 60) / 25 / 3600)) : 0;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_10rem]">
      <div>
      <PageHead
        label="운영"
        title="시스템이 지금 제대로 돌고 있는가"
        lead="자동 작업 상태와 확인할 문제를 보여 줍니다. 문제가 없으면 조치할 일이 없습니다."
        workflow={[
          { label: '현재 상태' },
          { label: '확인할 문제', href: '#ops-attention' },
          { label: '필요한 작업', href: '#ops-actions' },
          { label: '처리 내역', href: '#ops-recent' },
        ]}
      />

      {error && <ConnectionError error={error} />}

      {data && (
        <>
          {/* ── 1. 한눈에 ─────────────────────────────────────────── */}
          <Section id="ops-status" title="지금 상태" lead="다섯 가지가 모두 초록이면 손댈 것이 없습니다.">
            <div className="grid gap-x-8 sm:grid-cols-2">
              <Signal
                label="의미 검색 준비"
                level={data.ops.parked > 0 ? 'halt' : data.ops.in_flight > 0 ? 'caution' : 'ok'}
                value={
                  data.ops.parked > 0
                    ? `보류 ${data.ops.parked}건 — 확인 필요`
                    : data.ops.in_flight > 0
                      ? `처리 중 ${data.ops.in_flight}건`
                      : '정상 — 밀린 것 없음'
                }
                note="새 자료가 들어오면 1분 안에 뜻으로 찾을 수 있게 준비합니다"
              />
              <Signal
                label="자동 작업"
                level={data.ops.cron_failed_24h > 0 ? 'halt' : 'ok'}
                value={
                  data.ops.cron_failed_24h > 0
                    ? `최근 24시간 ${data.ops.cron_failed_24h}회 실패`
                    : '정상 — 최근 24시간 실패 없음'
                }
                note="이것이 멈추면 아무것도 자동으로 갱신되지 않습니다"
              />
              <Signal
                label="의미 검색 기준"
                level={data.ops.embedding_models > 1 ? 'halt' : 'ok'}
                value={
                  data.ops.embedding_models > 1
                    ? `기준 ${data.ops.embedding_models}종 섞임 — 검색을 믿을 수 없음`
                    : '정상 — 하나로 통일됨'
                }
                note="기준이 섞이면 오류 없이 검색 품질만 조용히 나빠집니다"
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
              <Signal
                label="정기 실행"
                level={data.jobsConfigured ? 'ok' : 'caution'}
                value={
                  data.jobsConfigured
                    ? '설정됨 — 리콜 수집·기준 동기화가 매일 돕니다'
                    : '설정 안 됨 — 자동으로 돌지 않습니다'
                }
                note={
                  data.jobsConfigured
                    ? '새벽 3시 40분·50분(한국 시각)'
                    : 'JOBS_TOKEN 을 .env.local 과 Netlify 에 넣고 npm run ops:secret 을 실행하세요'
                }
              />
            </div>
          </Section>

          {/* 진행 중인 일이 있으면 화면이 스스로 따라간다 */}
          <div className="mt-4">
            <AutoRefresh
              active={data.ops.in_flight > 0 || data.embed.some((e) => e.pending > 0)}
              seconds={20}
              label="의미 검색 준비가 진행 중입니다 — 숫자가 저절로 갱신됩니다"
            />
          </div>

          {/* ── 2. 최근에 무엇이 돌았나 (담당자 요청) ──────────────── */}
          <Section
            id="ops-recent"
            title="최근 처리"
            lead="자동으로 돈 일과 그 결과입니다. 무엇이 언제 얼마나 처리됐는지 여기서 봅니다."
          >
            <div className="border-t border-rule py-2.5 text-[12px]">
              <span className="text-ink">오늘 의미 검색 준비</span>
              <span className="addr tnum ml-2 text-ink-2">{data.embeddedToday.toLocaleString()}건</span>
              <span className="ml-2 text-ink-3">최근 24시간 안에 준비된 조항</span>
            </div>

            {data.runs.length === 0 ? (
              <p className="border-t border-rule py-2.5 text-[12px] text-ink-3">
                정기 실행 기록이 아직 없습니다. 아래 「지금 하기」에서 눌러 보거나, 새벽에
                자동으로 도는 것을 기다리면 됩니다.
              </p>
            ) : (
              data.runs.map((r, i) => (
                <div key={i} className="border-t border-rule py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span className="text-[13px] font-medium">{RUN_LABEL[r.job] ?? r.job}</span>
                    <span className="addr tnum text-[11px] text-ink-3">{when(r.started_at)}</span>
                  </div>
                  <div
                    className={`mt-0.5 text-[11px] leading-snug ${
                      r.status_code != null && r.status_code !== 200 ? 'text-halt' : 'text-ink-2'
                    }`}
                  >
                    {describeRun(r)}
                  </div>
                </div>
              ))
            )}
          </Section>

          {/* ── 3. 사람이 봐야 할 것 ──────────────────────────────── */}
          {(data.parkedRows.length > 0 || data.cronFailures.length > 0) && (
            <Section
              id="ops-attention"
              title="확인이 필요한 것"
              lead="자동으로 풀리지 않아 사람의 판단이 필요한 항목입니다."
            >
              {data.parkedRows.length > 0 && (
                <div className="border border-halt bg-halt-soft px-4 py-3">
                  <div className="text-[13px] font-semibold text-halt">
                    의미 검색 준비 보류 {data.parkedRows.length}건
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
                    다섯 번 시도해도 준비되지 않았습니다. 원인을 고친 뒤 아래 「보류 건 다시
                    시도」를 누르세요. 그때까지 이 자료는 뜻으로 찾는 검색에 잡히지 않습니다.
                  </p>
                  <ul className="mt-3">
                    {data.parkedRows.map((p) => (
                      <li
                        key={`${p.target_table}-${p.row_id}`}
                        className="border-t border-halt/20 py-2 text-[12px]"
                      >
                        <span className="addr text-ink">
                          {TARGET_LABEL[p.target_table] ?? p.target_table} #{p.row_id}
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
                    자동 작업 실패 {data.cronFailures.length}건 (최근 24시간)
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

          {/* ── 4. 조작 ───────────────────────────────────────────── */}
          <Section
            id="ops-actions"
            title="지금 하기"
            lead="아래 버튼들은 여러 번 눌러도 안전합니다. 자동으로 일어날 일을 앞당길 뿐입니다."
          >
            <div className="flex flex-wrap gap-3">
              <ActionForm
                action={async () => { 'use server'; return runEmbedTick(); }}
                label="의미 검색 준비 지금 실행"
                pendingLabel="실행하는 중…"
                className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-measure-soft"
              />
              <ActionForm
                action={runJobNow}
                hidden={{ job: 'recalls-fetch' }}
                label="리콜 지금 가져오기"
                pendingLabel="요청하는 중…"
                className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-measure-soft"
              />
              <ActionForm
                action={runJobNow}
                hidden={{ job: 'standards-sync' }}
                label="안전기준 폴더 확인"
                pendingLabel="요청하는 중…"
                className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-measure-soft"
              />
              {data.ops.parked > 0 && (
                <ActionForm
                  action={async () => { 'use server'; return retryParked(); }}
                  label={`보류 ${data.ops.parked}건 다시 시도`}
                  pendingLabel="되돌리는 중…"
                  className="border border-halt bg-surface px-4 py-2 text-[13px] text-halt hover:bg-halt-soft"
                />
              )}
            </div>

            {/*
              돈이 드는 유일한 조작 — 켜기 전에 얼마인지 보여 준다.

              한 번 눌러 두면 끝까지 도는 구조다(026). 전에는 18초어치씩만 하고
              멈춰서, 남은 수천 건을 끝내려면 수천 번을 눌러야 했다 — 자동이 아니라
              수동을 잘게 쪼갠 것이었다.
            */}
            <div className="mt-5 border border-caution bg-caution-soft px-4 py-3">
              <div className="text-[13px] font-semibold text-caution">
                위해요인 코드 부여 — 비용이 드는 작업
              </div>

              {data.taggable === 0 ? (
                <p className="mt-1.5 text-[12px] text-ink-2">
                  코드를 부여할 요건 조항이 남아 있지 않습니다. 모두 끝났습니다.
                </p>
              ) : (
                <>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                    아직 코드가 없는 요건 조항이{' '}
                    <span className="addr tnum text-ink">{data.taggable.toLocaleString()}건</span>{' '}
                    남았습니다. 전부 처리하면 약{' '}
                    <span className="addr text-ink">${tagCost}</span> 가 들고, 실측 속도로{' '}
                    <span className="text-ink">약 {tagHours}시간</span> 걸립니다. 코드가 있어야
                    사고·리콜과 조항을 코드로 맞춰 볼 수 있습니다.
                  </p>

                  {data.autoTagging ? (
                    <>
                      <div className="mt-3 flex flex-wrap items-baseline gap-2">
                        <span className="text-[13px] font-medium text-measure">
                          자동 실행 중 — 1분마다 스스로 이어서 하고 있습니다
                        </span>
                        <AutoRefresh
                          active
                          seconds={20}
                          label="남은 건수가 저절로 갱신됩니다"
                        />
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                        이 화면을 닫아도 계속 돕니다. 다 끝나면 저절로 꺼지면서 텔레그램으로
                        알려 드립니다. 진행 상황은 위 남은 건수로 확인하세요.
                      </p>
                      <div className="mt-3">
                        <ActionForm
                          action={toggleAutoTagging}
                          hidden={{ on: 'false' }}
                          label="멈추기"
                          pendingLabel="멈추는 중…"
                          className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft"
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                        켜 두면 1분마다 스스로 이어서 합니다. 화면을 닫아도 계속 돌고, 다 끝나면
                        저절로 꺼집니다. 퇴근 전에 켜 두면 아침에 끝나 있습니다.
                        언제든 멈출 수 있고, 멈춰도 그때까지 한 것은 그대로 남습니다.
                      </p>
                      <div className="mt-3">
                        <ActionForm
                          action={toggleAutoTagging}
                          hidden={{ on: 'true' }}
                          label={`자동 실행 켜기 (약 ${tagCost})`}
                          pendingLabel="켜는 중…"
                          className="border border-caution bg-caution px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
                        />
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </Section>

          {/* ── 5. 자동 작업 상세 ─────────────────────────────────── */}
          <Section
            id="ops-details"
            title="자동으로 도는 일"
            lead="데이터베이스 안에서 스스로 돕니다. 웹사이트가 꺼져 있어도 돌아갑니다."
          >
            <div className="label grid grid-cols-[1fr_auto_auto] gap-3 pb-2">
              <span>하는 일</span>
              <span>주기</span>
              <span className="text-right">마지막 실행</span>
            </div>
            {data.jobs.map((j) => (
              <div
                key={j.jobname}
                className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3 border-t border-rule py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-[12px]">{JOB_PURPOSE[j.jobname] ?? j.jobname}</div>
                  <div className="addr text-[11px] text-ink-3">
                    {j.jobname}
                    {!j.active && <span className="text-halt"> · 꺼짐</span>}
                    {j.last_status === 'failed' && <span className="text-halt"> · 실패</span>}
                  </div>
                </div>
                <span className="addr text-[11px] text-ink-3">{j.schedule}</span>
                <span className="addr tnum text-right text-[11px] text-ink-3">
                  {when(j.last_at)}
                </span>
              </div>
            ))}

            <div className="label mt-8 grid grid-cols-[1fr_repeat(4,minmax(48px,auto))] gap-3 pb-2">
              <span>자료</span>
              <span className="text-right">전체</span>
              <span className="text-right">준비됨</span>
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
                    {TARGET_LABEL[e.target_table] ?? e.target_table}
                  </div>
                  <div className="text-[11px] text-ink-3">
                    {e.total - e.embedded > 0 && e.pending === 0
                      ? `${(e.total - e.embedded).toLocaleString()}건은 아직 준비할 재료(검색용 문장)가 없습니다`
                      : '준비할 수 있는 것은 모두 준비됨'}
                  </div>
                </div>
                <span className="addr tnum text-right text-[13px] text-ink-2">
                  {e.total.toLocaleString()}
                </span>
                <span className="addr tnum text-right text-[13px]">{e.embedded.toLocaleString()}</span>
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

          {/* ── 6. 알림 ───────────────────────────────────────────── */}
          <Section
            id="ops-alerts"
            title="알림 (텔레그램)"
            lead="문제가 생기면 다섯 가지를 알립니다 — 의미 검색 준비 보류, 자동 작업 실패, 의미 검색 기준 혼재, 정기 작업 실패, 원문 확인이 오래 밀린 사고보고서. 알림이 시끄러우면 아무도 읽지 않기 때문에 일부러 좁게 뒀습니다. 좋은 소식(새 리콜 도착, 코드 부여 완료)도 함께 옵니다."
          >
            {!data.ops.telegram_configured ? (
              <div className="border border-caution bg-caution-soft px-4 py-3">
                <div className="text-[13px] font-semibold text-caution">아직 설정되지 않았습니다</div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                  지금은 문제가 생겨도 연락이 가지 않습니다. 화면을 열어야만 알 수 있습니다.
                </p>
                <ol className="mt-3 space-y-2 text-[12px] text-ink-2">
                  <li>
                    <span className="text-ink">1.</span> 텔레그램{' '}
                    <span className="addr">@BotFather</span> 에서 봇을 만들고 토큰을 받습니다.
                  </li>
                  <li>
                    <span className="text-ink">2.</span>{' '}
                    <code className="addr text-ink">.env.local</code> 에{' '}
                    <code className="addr text-ink">TELEGRAM_BOT_TOKEN</code> 을 넣고{' '}
                    <code className="addr text-ink">npm run ops:secret</code> 을 실행합니다.
                  </li>
                </ol>
              </div>
            ) : (
              <>
                {/* 담당자 요청: 알림을 더 폭넓게 쓸 수 있도록 */}
                <div className="border border-rule bg-surface px-4 py-4">
                  <div className="text-[13px] font-medium">직접 보내기</div>
                  <p className="mt-1 mb-3 text-[11px] leading-relaxed text-ink-3">
                    쓴 내용을 그대로 텔레그램으로 보냅니다. 메모를 남기거나 알림이 잘 오는지
                    확인할 때 씁니다.
                  </p>
                  <ActionForm
                    action={sendCustomMessage}
                    textInput={{ name: 'message', placeholder: '보낼 내용' }}
                    label="보내기"
                    pendingLabel="보내는 중…"
                    className="border border-measure bg-measure px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
                  />
                </div>

                <div className="mt-3">
                  <ActionForm
                    action={async () => { 'use server'; return sendTestAlert(); }}
                    label="시험 알림 보내기"
                    pendingLabel="보내는 중…"
                    className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-measure-soft"
                  />
                </div>
              </>
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

          {/* ── 7. 접속 관리 ──────────────────────────────────────── */}
          <Section
            id="ops-access"
            title="사이트 접속 관리 (ID · 비밀번호)"
            lead="이 사이트는 주소만 알면 누구나 들어올 수 있는 곳에 있습니다. 그래서 앞단에 ID/비밀번호를 두고 외부 접근을 막습니다."
          >
            <div className="grid gap-x-8 sm:grid-cols-2">
              <Signal
                label="현재 잠금 상태"
                level={authPassSet ? 'ok' : 'halt'}
                value={authPassSet ? '잠겨 있음' : '열려 있음 — 누구나 접근 가능'}
                note={authPassSet ? '로그인 창이 뜹니다' : '비밀번호가 설정되지 않았습니다'}
              />
              <Signal
                label="사용자이름 검사"
                level={authUser ? 'ok' : 'caution'}
                value={authUser ? `"${authUser}" 만 허용` : '검사하지 않음 — 아무 값이나 통과'}
                note="비워 두면 비밀번호만 맞으면 들어옵니다"
              />
            </div>

            <div className="mt-6 border-t border-rule pt-5">
              <div className="label">바꾸는 곳</div>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-2">
                Netlify 대시보드 →{' '}
                <span className="text-ink">Site configuration → Environment variables</span> 에서{' '}
                <code className="addr text-ink">SITE_AUTH_PASSWORD</code> (필요하면{' '}
                <code className="addr text-ink">SITE_AUTH_USERNAME</code> 도) 값을 고칩니다.
              </p>
            </div>
          </Section>

          <TermsNote />
        </>
      )}
      </div>
      <PageToc items={OPS_TOC} />
      </div>
    </div>
  );
}
