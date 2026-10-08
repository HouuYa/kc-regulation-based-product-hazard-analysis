import Link from 'next/link';
import { getDb } from '@/lib/db';
import { ConnectionError } from '@/components/Panel';
import { ActionForm } from '@/components/ActionForm';
import { AutoRefresh } from '@/components/AutoRefresh';
import { PageToc, type TocItem } from '@/components/PageToc';
import { Signal, Section, when, TARGET_LABEL } from '@/components/AdminParts';
import { usageSummary, type UsageSummary } from '@/lib/llm/usage';
import { sendTestAlert, sendCustomMessage } from './actions';

/**
 * 관리 · 상태·알림 탭 (옛 /ops 의 앞쪽 절들)
 *
 * 이 탭이 답해야 하는 질문
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

interface RunRow {
  job: string;
  started_at: string;
  status_code: number | null;
  response: string | null;
  /** 이 구간에 대한 몇 번째 시도인가. 1 이 최초, 2 이상이면 자동 재시도다(035) */
  attempt: number;
}

interface Data {
  ops: OpsStatus;
  /** 의미 검색 준비가 기다리는 건수 합 — 화면 자동 갱신을 켤지 정하는 데만 쓴다 */
  embedPending: number;
  runs: RunRow[];
  parkedRows: { target_table: string; row_id: number; attempts: number; last_error: string | null }[];
  cronFailures: { jobname: string; end_time: string; message: string | null }[];
  alerts: { kind: string; body: string; status_code: number | null; sent_at: string }[];
  /** 자동 복구 현황 — 스스로 다시 돌린 것과 결국 포기한 것(035) */
  recovery: {
    retried: number;
    gaveUp: number;
    taggingRecovered: number;
    embeddingRecovered: number;
  };
  /** AI 사용 이상 여부만 보려고 읽는다(052). 조회에 실패하면 null */
  usage: UsageSummary | null;
  embeddedToday: number;
  jobsConfigured: boolean;
  /*
    최근 발송 요약 (담당자 요청, 2026-09-09)
    "발송 내역 목록이 길어지니깐 접히게 하고, 최근 발송 내역을 요약해서 간단히 보이기 —
     예를 들어 몇월몇일 몇시부터 현재까지 전달 성공·실패 몇건."
  */
  alertStat: { sent: number; ok: number; failed: number; pending: number; since: string | null };
}

const RUN_LABEL: Record<string, string> = {
  'recalls-fetch': '리콜 수집',
  'standards-sync': '안전기준 동기화',
  'tag-chunk': '위해요인 코드 부여',
};

const TOC: TocItem[] = [
  { id: 'ops-status', label: '지금 상태' },
  { id: 'ops-recent', label: '최근 처리' },
  { id: 'ops-attention', label: '확인이 필요한 것' },
  { id: 'ops-alerts', label: '알림' },
  { id: 'ops-access', label: '접속 관리' },
];

async function load(): Promise<{ data: Data | null; error: string | null }> {
  try {
    const db = getDb();

    const [ops] = await db<OpsStatus[]>`select * from public.ops_status`;
    const [ep] = await db<{ n: number }[]>`
      select coalesce(sum(pending), 0)::int as n from public.embed_status
    `;

    const runs = await db<RunRow[]>`
      select job, started_at::text, status_code, response, attempt
      from public.job_run order by started_at desc limit 8
    `;

    /*
      자동 복구가 무엇을 하고 있는가 (035)

      담당자 지적에서 나온 화면이다 — "막힌 것을 자동으로 다시 돌려야 하는 것
      아닌가". 이제 자동으로 돌리지만, 자동으로 도는 것일수록 무엇이 몇 번
      되풀이되고 있는지 보여야 한다. 조용히 매일 같은 일을 다시 하고 있으면
      그것은 고쳐진 것이 아니다.
    */
    const [recovery] = await db<Data['recovery'][]>`
      select
        (select count(*)::int from public.job_run
          where attempt > 1 and started_at > now() - interval '24 hours')      as retried,
        (select count(*)::int from public.job_run j
          where j.attempt >= 3 and j.status_code >= 500
            and j.started_at > now() - interval '24 hours')                    as gaveUp,
        (select coalesce(sum(affected), 0)::int from public.recovery_log
          where kind = 'tagging' and ran_at > now() - interval '7 days')       as taggingRecovered,
        (select coalesce(sum(affected), 0)::int from public.recovery_log
          where kind = 'embedding' and ran_at > now() - interval '7 days')     as embeddingRecovered
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

    const [e] = await db<{ n: number }[]>`
      select count(*)::int as n from public.clause where embedded_at > now() - interval '24 hours'
    `;

    const [j] = await db<{ ok: boolean }[]>`
      select (exists (select 1 from vault.decrypted_secrets where name = 'jobs_token')
              and exists (select 1 from vault.decrypted_secrets where name = 'site_base_url')) as ok
    `;

    const [alertStat] = await db<Data['alertStat'][]>`
      select count(*)::int                                        as sent,
             count(*) filter (where status_code = 200)::int       as ok,
             count(*) filter (where status_code is not null
                                and status_code <> 200)::int      as failed,
             count(*) filter (where status_code is null)::int     as pending,
             min(sent_at)::text                                   as since
      from public.ops_alert
      where sent_at > now() - interval '7 days'
    `;

    // AI 사용·비용 (052). 기록이 없어도 화면은 떠야 하므로 실패해도 넘어간다
    let usage: UsageSummary | null = null;
    try {
      usage = await usageSummary(30);
    } catch (err) {
      console.error('AI 사용 현황 조회 실패:', err);
    }

    return {
      data: {
        ops, embedPending: ep.n, runs, parkedRows, cronFailures, alerts,
        recovery, usage,
        embeddedToday: e.n, jobsConfigured: j.ok,
        alertStat,
      },
      error: null,
    };
  } catch (e) {
    console.error('관리 화면(상태·알림) 조회 실패:', e);
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 라우트가 돌려준 JSON 요약을 사람이 읽을 문장으로 */
function describeRun(r: RunRow): string {
  // 자동 재시도로 생긴 실행임을 먼저 밝힌다 — 같은 작업이 여러 줄 보이는 이유다
  const retry = r.attempt > 1 ? `[자동 재시도 ${r.attempt}회차] ` : '';
  if (r.status_code == null) return `${retry}결과를 기다리는 중`;
  if (r.status_code !== 200) {
    const gaveUp = r.attempt >= 3 ? ' — 재시도 한도에 이르러 더 시도하지 않습니다' : '';
    return `${retry}실패 (HTTP ${r.status_code})${gaveUp} ${(r.response ?? '').slice(0, 100)}`;
  }
  try {
    const j = JSON.parse(r.response ?? '{}');
    if (r.job === 'recalls-fetch') {
      if (retry) return `${retry}조회 ${j.received ?? 0}건 · 새로 들어옴 ${j.newCase ?? 0}건`;
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

export async function StatusTab() {
  const { data, error } = await load();

  const authUser = process.env.SITE_AUTH_USERNAME?.trim() ?? '';
  const authPassSet = Boolean(process.env.SITE_AUTH_PASSWORD?.trim());

  /*
    AI 사용은 「AI 사용과 비용」 탭에 전부 있다. 전에는 운영 화면에도 요약 절이
    따로 있어 같은 숫자가 두 군데 떠 있었다(P3-6). 여기에는 손댈 일이 있을 때만
    한 줄을 남긴다 — 실패한 호출이 있거나, 단가를 몰라 금액에서 빠진 모델이 있을 때.
  */
  const llmWarn = data?.usage
    ? [
        data.usage.totalFailed > 0 && `최근 30일 AI 호출 실패 ${data.usage.totalFailed.toLocaleString()}회`,
        data.usage.unpricedModels.length > 0
          && `단가가 없어 금액에서 빠진 모델 ${data.usage.unpricedModels.join(', ')}`,
      ].filter((s): s is string => Boolean(s))
    : [];

  return (
    <>
      {error && <ConnectionError error={error} />}

      {data && (
        <>
          {/* ── 1. 한눈에 ─────────────────────────────────────────── */}
          <Section id="ops-status" title="지금 상태" lead="다섯 가지가 모두 초록이면 손댈 것이 없습니다.">
            <div className="grid gap-x-8 sm:grid-cols-2">
              <Signal
                label="의미 검색 준비 (안전기준 조항 · 사고보고서 · 리콜)"
                level={data.ops.parked > 0 ? 'halt' : data.ops.in_flight > 0 ? 'caution' : 'ok'}
                value={
                  data.ops.parked > 0
                    ? `보류 ${data.ops.parked}건 — 확인 필요`
                    : data.ops.in_flight > 0
                      ? `처리 중 ${data.ops.in_flight}건`
                      : '정상 — 밀린 것 없음'
                }
                note="낱말이 달라도 뜻이 같은 것을 찾으려면 문장을 미리 숫자로 바꿔 둬야 합니다(임베딩). 새 자료가 들어오면 1분 안에 준비합니다. 자료별 진행은 「자동 작업」 탭에 있습니다"
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

            {llmWarn.length > 0 && (
              <p className="mt-4 border border-caution bg-caution-soft px-4 py-2.5 text-[12px] leading-relaxed text-ink-2">
                <span className="font-semibold text-caution">AI 사용 확인 필요</span> — {llmWarn.join(' · ')}.{' '}
                <Link
                  href="/admin?tab=llm"
                  className="underline decoration-rule underline-offset-2 hover:text-measure"
                >
                  AI 사용과 비용 탭에서 보기
                </Link>
              </p>
            )}
          </Section>

          {/* 진행 중인 일이 있으면 화면이 스스로 따라간다 */}
          <div className="mt-4">
            <AutoRefresh
              active={data.ops.in_flight > 0 || data.embedPending > 0}
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
                정기 실행 기록이 아직 없습니다. 「자동 작업」 탭의 「지금 하기」에서 눌러 보거나,
                새벽에 자동으로 도는 것을 기다리면 됩니다.
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
              {/*
                자동 복구가 한 일을 먼저 보여 준다 (035)

                이 화면의 원래 뜻은 "사람이 볼 것"인데, 그 앞에 "기계가 이미 처리한 것"을
                두는 이유가 있다. 자동 복구는 조용히 돌기 때문에, 무엇이 몇 번 되풀이되고
                있는지 적어 두지 않으면 "문제가 없다"와 "매일 같은 문제를 덮고 있다"가
                화면에서 똑같아 보인다. 뒤쪽이면 그건 고쳐진 것이 아니다.
              */}
              <div className="mb-5 border border-rule-soft px-4 py-3">
                <div className="text-[13px] font-semibold">스스로 되돌린 것 (최근)</div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                  실패한 정기 작업 자동 재시도{' '}
                  <span className="addr tnum text-ink">{data.recovery.retried}건</span>
                  {' · '}재시도 한도까지 갔는데도 실패{' '}
                  <span className={`addr tnum ${data.recovery.gaveUp > 0 ? 'text-halt' : 'text-ink'}`}>
                    {data.recovery.gaveUp}건
                  </span>
                  <span className="text-ink-3"> (최근 24시간)</span>
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
                  세워 둔 것을 다시 대상에 넣은 횟수 — 위해요인 코드{' '}
                  <span className="addr tnum text-ink">{data.recovery.taggingRecovered}건</span>
                  {' · '}의미 검색 준비{' '}
                  <span className="addr tnum text-ink">{data.recovery.embeddingRecovered}건</span>
                  <span className="text-ink-3"> (최근 7일)</span>
                </p>
                {data.recovery.gaveUp > 0 && (
                  <p className="mt-2 text-[11px] leading-relaxed text-halt">
                    세 번까지 다시 시도했는데도 실패한 작업이 있습니다. 일시적인 장애가
                    아니라는 뜻이므로 아래 「최근 처리」에서 사유를 확인해 주세요.
                  </p>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                  정기 작업은 실패하면 5분 안에 스스로 두 번까지 다시 시도합니다.
                  세워 둔 코드 부여와 의미 검색 준비는 매일 새벽에 다시 대상에 들어갑니다.
                  같은 건수가 며칠 내리 반복되면 자동으로 풀리지 않는 것이므로 알림을 보냅니다.
                </p>
              </div>

              {data.parkedRows.length > 0 && (
                <div className="border border-halt bg-halt-soft px-4 py-3">
                  <div className="text-[13px] font-semibold text-halt">
                    의미 검색 준비 보류 {data.parkedRows.length}건
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
                    다섯 번 시도해도 준비되지 않았습니다. 원인을 고친 뒤{' '}
                    <Link
                      href="/admin?tab=jobs#ops-actions"
                      className="underline decoration-rule underline-offset-2 hover:text-measure"
                    >
                      「자동 작업」 탭의 「보류 건 다시 시도」
                    </Link>
                    를 누르세요. 그때까지 이 자료는 뜻으로 찾는 검색에 잡히지 않습니다.
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

          {/* ── 4. 알림 ───────────────────────────────────────────── */}
          {/*
            알림 규칙은 071 에서 좁혔다 — 보낸 알림의 79%가 다음 실행이 저절로 메우는
            일시적 실패였다. 설명도 그 규칙에 맞춘다. 화면이 옛 규칙을 말하면 담당자는
            "왜 504 가 났는데 알림이 안 오지?"를 고장으로 읽는다.
          */}
          <Section
            id="ops-alerts"
            title="알림 (텔레그램)"
            lead="사람이 손을 대야 하는 문제만 알립니다 — 의미 검색 준비 보류, 자동 작업 실패, 의미 검색 기준 혼재, 정기 작업 이상, 원문 확인이 오래 밀린 사고보고서, AI 호출 실패, 원본 파일 보관 실패. 정기 작업은 30분 넘게 한 번도 성공하지 못했을 때, 같은 구간이 재시도까지 세 번 모두 실패했을 때, 설정 오류(4xx)일 때만 보냅니다 — 잠깐의 실패(502·503·504)는 다음 실행과 자동 재시도가 메우므로 보내지 않습니다. 원문 확인 대기는 건수가 늘었거나 마지막 알림 뒤 14일이 지났을 때만 다시 보냅니다. 알림이 시끄러우면 아무도 읽지 않기 때문입니다. 좋은 소식(새 리콜 도착, 코드 부여 완료)도 함께 옵니다."
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

            {/*
              요약을 먼저, 목록은 접어 둔다 (담당자 요청, 2026-09-09)
              목록이 길어지면 화면 아래쪽이 알림 내역으로 뒤덮여 그 아래 「접속 관리」가
              보이지 않는다. 평소에 알고 싶은 것은 "잘 가고 있나" 한 줄이다.
            */}
            {data.alertStat.sent > 0 && (
              <div className="mt-6 border border-rule-soft px-4 py-3 text-[12px] leading-relaxed text-ink-2">
                <span className="addr tnum text-ink">{when(data.alertStat.since)}</span> 부터 지금까지{' '}
                <span className="text-ink">{data.alertStat.sent}건</span> 보냈습니다 —{' '}
                <span className="text-measure">전달 {data.alertStat.ok}건</span>
                {data.alertStat.failed > 0 && (
                  <span className="text-halt"> · 실패 {data.alertStat.failed}건</span>
                )}
                {data.alertStat.pending > 0 && (
                  <span className="text-ink-3"> · 확인 중 {data.alertStat.pending}건</span>
                )}
                .
                {data.alertStat.failed > 0 && (
                  <span className="text-ink-3">
                    {' '}실패가 있으면 봇 토큰이나 대화 번호가 바뀌었는지 봅니다.
                  </span>
                )}
              </div>
            )}

            {data.alerts.length > 0 && (
              <details className="mt-3 border border-rule-soft">
                <summary className="cursor-pointer px-4 py-2.5 text-[12px] text-ink-2">
                  최근 발송 내역 {data.alerts.length}건 펼쳐 보기
                </summary>
                <div className="border-t border-rule-soft px-4 pb-2">
                  {data.alerts.map((a, i) => (
                    <div key={i} className="border-t border-rule-soft py-2.5 first:border-t-0">
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
                </div>
              </details>
            )}
          </Section>

          {/* ── 5. 접속 관리 ──────────────────────────────────────── */}
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
        </>
      )}
      <PageToc items={TOC} />
    </>
  );
}
