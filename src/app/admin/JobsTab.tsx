import Link from 'next/link';
import { getDb } from '@/lib/db';
import { ConnectionError } from '@/components/Panel';
import { ActionForm } from '@/components/ActionForm';
import { AutoRefresh } from '@/components/AutoRefresh';
import { PageToc, type TocItem } from '@/components/PageToc';
import { Section, when, TARGET_LABEL } from '@/components/AdminParts';
import { countPendingPhotoVision } from '@/lib/cases/photo-vision-run';
import {
  runEmbedTick, retryParked, runJobNow, toggleAutoTagging, togglePhotoVision, resetTagFailures,
} from './actions';

/**
 * 관리 · 자동 작업 탭 (옛 /ops 의 「지금 하기」·「자동으로 도는 작업」)
 *
 * 「의미 검색 준비」를 자료별로 자세히 보여 주는 곳은 이제 여기 하나뿐이다(P3-6).
 * 사고보고서·리콜·홈 화면은 건수 한 줄만 보여 주고, 무엇이 왜 막혔는지는 여기서 본다.
 */

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

interface Data {
  /** 다섯 번 실패해 세워 둔 의미 검색 준비 건수 (ops_status.parked) */
  parked: number;
  embed: EmbedRow[];
  jobs: JobRow[];
  taggable: number;
  /** 세 번 연속 실패해 자동 대상에서 빠진 조항. 남은 건수와 절대 합치지 않는다(029) */
  stalledTagging: number;
  autoTagging: boolean;
  /** 아직 비전 분석하지 않은 사진이 딸린 사고보고서 건수 (068) */
  pendingPhotoVision: number;
  photoVisionOn: boolean;
  /*
    검색용 문장이 없어 뜻 검색을 준비할 수 없는 것들 (담당자 요청, 2026-09-09)

    "1건은 아직 준비할 재료(검색용 문장)가 없습니다" 라고만 적혀 있으니
    "문제가 있는 KC안전기준 명 또는 파일명을 알려 주면 디버깅이 편하다"는
    지적을 받았다. 맞는 말이다 — 숫자만 있고 무엇인지 모르면 손을 댈 수가 없다.
    조항은 건수가 많으므로 기준별로 묶어 상위 몇 개를, 사고보고서·리콜은
    건별로 보여 준다.
  */
  noMaterialClause: { display_name: string; name: string | null; n: number }[];
  noMaterialCase: { id: number; source_type: string; label: string | null }[];
}

/*
  자동 작업이 하는 일 (담당자 지적, 2026-09-09)

  "전반적으로 초보자가 보기에 가독성과 의미가 어렵다. auto-recover 가 무슨 뜻인지,
   30일 지난 실행 기록이 무슨 실행 기록인지 모르겠다."

  두 가지가 문제였다. 첫째로 auto-recover 와 job-retry 는 여기 목록에 아예 없어서
  영어 이름이 그대로 화면에 나왔다 — 목록에 없으면 jobname 을 그대로 찍는 코드였다.
  둘째로 있는 것들도 한 줄이라 "왜 이게 필요한가"가 빠져 있었다.

  그래서 한 줄 요약(what)과 한 문단 설명(why)을 나눠 담는다. 목록에서는 요약만
  보이고, 펼치면 설명이 나온다.
*/
interface JobInfo {
  /** 한 줄 요약 — 목록에 늘 보인다 */
  what: string;
  /** 펼쳤을 때 나오는 설명. 왜 필요한지, 무엇을 건드리는지 */
  why: string;
}

const JOB_INFO: Record<string, JobInfo> = {
  'embed-tick': {
    what: '뜻으로 찾을 수 있게 자료를 준비한다',
    why: '안전기준 조항·사고보고서·리콜의 문장을 숫자 목록(임베딩)으로 바꿔 둡니다. 이것이 있어야 「감전」으로 찾을 때 「전격」이라고 적힌 조항도 함께 걸립니다. 새 자료가 들어오면 자동으로 대상이 됩니다.',
  },
  'ops-watch': {
    what: '문제를 찾아 텔레그램으로 알린다',
    why: '「상태·알림」 탭의 「알림」 절에 적힌 것들을 5분마다 살펴보고, 걸리는 것이 있으면 알립니다. 화면을 열어 봐야만 알 수 있는 상태를 없애기 위한 작업입니다.',
  },
  'auto-recover': {
    what: '막힌 것을 스스로 다시 돌린다',
    why: '일시적인 문제(네트워크 끊김, 상대 서버의 순간 오류)로 멈춘 작업을 사람 손을 거치지 않고 다시 시도합니다. 위해요인 코드 부여와 의미 검색 준비가 대상입니다. 다시 돌린 건수와 결국 포기한 건수는 「상태·알림」 탭에 나옵니다 — 조용히 매일 같은 일을 되풀이하고 있으면 그것은 고쳐진 것이 아니기 때문입니다.',
  },
  'job-retry': {
    what: '실패한 정기 작업을 다시 부른다',
    why: '아래 job- 으로 시작하는 작업들이 실패로 끝났을 때 다시 부릅니다. 세 번까지 시도하고 그래도 안 되면 포기하고 알림을 보냅니다.',
  },
  'cron-log-prune': {
    what: '오래된 실행 기록을 지운다',
    why: '이 절에 보이는 자동 작업들이 언제 돌아 성공했는지 실패했는지의 기록(cron.job_run_details)입니다. 1분마다 도는 작업이 있어 하루에 수천 줄이 쌓이므로, 30일이 지난 것은 지웁니다. 자료 자체가 아니라 실행 이력만 지웁니다.',
  },
  'job-recalls-fetch': {
    what: '새 리콜을 가져온다',
    why: '해외 리콜 원본 시스템에서 새로 승인된 건을 받아 옵니다. 2분마다 확인하지만 새것이 없으면 아무 일도 하지 않습니다.',
  },
  'job-standards-sync': {
    what: '안전기준 폴더에 새 문서가 있는지 본다',
    why: 'KC안전기준 폴더에 새 기준 문서가 들어왔는지 확인합니다. 넣는 것 자체는 사람이 명령으로 합니다 — 기준이 조용히 바뀌면 분석 결과도 조용히 바뀌기 때문입니다.',
  },
  'job-tag-chunk': {
    what: '위해요인 코드를 이어서 부여한다 (켜 뒀을 때만)',
    why: 'AI 를 불러 조항에 위해요인 코드를 붙입니다. 돈이 드는 작업이라 기본은 꺼져 있고, 위 「지금 하기」에서 켤 수 있습니다.',
  },
  'job-photo-vision': {
    what: '사고사진을 비전 분석한다 (켜 뒀을 때만)',
    why: 'AI로 사고보고서 첨부 사진을 봐서 무엇이 보이는지, 위해요인과 관련될 만한 손상이 있는지 적고, 증거 사진에서 뽑은 제품 서술로 GPC 품목분류까지 조회합니다(068). 웹 업로드가 사진을 추출·저장까지는 자동으로 하고, 이 AI 분석만 돈이 들어 기본은 꺼져 있습니다.',
  },
};

const TOC: TocItem[] = [
  { id: 'ops-actions', label: '지금 하기' },
  { id: 'ops-details', label: '자동으로 도는 작업' },
  { id: 'ops-embed', label: '의미 검색 준비' },
];

async function load(): Promise<{ data: Data | null; error: string | null }> {
  try {
    const db = getDb();

    const [ops] = await db<{ parked: number }[]>`select parked from public.ops_status`;
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

    // 코드를 붙일 수 있는데 아직 안 붙은 요건 조항 — 화면이 남은 일과 비용을 보여 준다.
    //
    // 세 번 연속 실패한 조항은 자동 대상이 아니므로 여기서 뺀다(029). 조건이
    // tag-run.ts 의 taggableWhere() 및 run_tag_chunk() 와 같아야 한다 — 어긋나면
    // "화면에는 남았다는데 처리할 것은 없는" 상태가 되고 자동 실행이 영원히 돈다.
    // 포기한 건수는 아래에서 따로 센다. 끝난 것과 포기한 것은 다른 상태다.
    const [t] = await db<{ n: number; stalled: number }[]>`
      select
        count(*) filter (where c.tag_fail_count <  3)::int as n,
        count(*) filter (where c.tag_fail_count >= 3)::int as stalled
      from public.clause c join public.standard s on s.id = c.standard_id
      where s.is_current and c.clause_role = 'REQUIREMENT'
        and length(btrim(c.body)) >= 15
        and not exists (select 1 from public.clause_tag ct where ct.clause_id = c.id)
    `;

    const [at] = await db<{ on: boolean }[]>`select public.auto_tagging_on() as on`;
    const [pv] = await db<{ on: boolean }[]>`select public.photo_vision_on() as on`;
    const pendingPhotoVision = await countPendingPhotoVision();

    /*
      뜻 검색을 준비할 수 없는 것들을 지목한다 (담당자 요청, 2026-09-09)

      검색용 문장(search_text)이 없으면 임베딩을 만들 수 없다. 지금까지 화면은
      건수만 말했는데, 그것만으로는 무엇을 고쳐야 할지 알 수 없다.
      조항은 기준별로 묶고(7천 건이 넘는다), 사고보고서·리콜은 건별로 짚는다.
    */
    const noMaterialClause = await db<Data['noMaterialClause']>`
      select s.display_name, coalesce(s.item_name, s.title_ko) as name, count(*)::int as n
      from public.clause c
      join public.standard s on s.id = c.standard_id
      where c.embedding is null
        and (c.search_text is null or length(btrim(c.search_text)) = 0)
      group by s.display_name, coalesce(s.item_name, s.title_ko)
      order by n desc limit 6
    `;

    const noMaterialCase = await db<Data['noMaterialCase']>`
      select id, source_type,
             coalesce(nullif(btrim(item_name), ''), title) as label
      from public.case_event
      where embedding is null
        and (search_text is null or length(btrim(search_text)) = 0)
      order by id desc limit 6
    `;

    return {
      data: {
        parked: ops.parked, embed, jobs,
        taggable: t.n, stalledTagging: t.stalled,
        autoTagging: at.on, pendingPhotoVision, photoVisionOn: pv.on,
        noMaterialClause, noMaterialCase,
      },
      error: null,
    };
  } catch (e) {
    console.error('관리 화면(자동 작업) 조회 실패:', e);
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * cron 표기를 사람 말로 — 「5분마다」를 뜻하는 cron 문자열은 담당자에게 아무 뜻도 아니다
 *
 * 데이터베이스는 UTC 로 돌므로 하루 한 번짜리는 한국시간으로 바꿔 적는다.
 * 알아볼 수 없는 표기는 원문을 그대로 보여 준다 — 틀리게 옮기느니 안 옮긴다.
 */
function humanSchedule(cron: string): string {
  if (cron === '* * * * *') return '1분마다';
  const everyMin = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (everyMin) return `${everyMin[1]}분마다`;
  const everyHour = /^(\d+) \*\/?(\d*) \* \* \*$/.exec(cron);
  if (everyHour && !everyHour[2]) return `매시 ${everyHour[1]}분`;
  const daily = /^(\d+) (\d+) \* \* \*$/.exec(cron);
  if (daily) {
    const kst = (Number(daily[2]) + 9) % 24;
    return `매일 ${String(kst).padStart(2, '0')}:${daily[1].padStart(2, '0')}`;
  }
  return cron;
}

export async function JobsTab() {
  const { data, error } = await load();

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
    <>
      {error && <ConnectionError error={error} />}

      {data && (
        <>
          {/* ── 1. 조작 ───────────────────────────────────────────── */}
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
              {data.parked > 0 && (
                <ActionForm
                  action={async () => { 'use server'; return retryParked(); }}
                  label={`보류 ${data.parked}건 다시 시도`}
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
                  코드를 부여할 요건 조항이 남아 있지 않습니다.
                  {data.stalledTagging === 0
                    ? ' 모두 끝났습니다.'
                    : ' 다만 아래 넘긴 조항은 확인이 필요합니다.'}
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

              {/*
                넘긴 조항 — 끝난 것과 포기한 것을 같은 숫자로 보여 주면 안 된다(029)

                전에는 실패한 조항이 대기줄 맨 앞에 그대로 남아, 자동 실행이 매 분
                같은 조항만 다시 부르고 남은 건수가 0 이 되지 않았다. 이제 세 번
                연속 실패하면 대상에서 빼는데, 그러면 "0건 남음"이 "다 됐다"는 뜻이
                아니게 된다. 그래서 여기에 따로 적는다.
              */}
              {data.stalledTagging > 0 && (
                <div className="mt-4 border-t border-caution/40 pt-3">
                  <p className="text-[12px] leading-relaxed text-ink-2">
                    <span className="addr tnum text-ink">
                      {data.stalledTagging.toLocaleString()}건
                    </span>
                    은 세 번 연속 실패해 넘겼습니다. 계속 다시 부르면 돈만 나가므로
                    자동 실행에서 뺐습니다. 조항 자체나 코드북의 문제일 수 있어 사람이
                    봐야 합니다.
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                    원인이 일시적인 것(모델 장애, 요청 한도)이었다면 되돌려서 다시
                    시도할 수 있습니다.
                  </p>
                  <div className="mt-3">
                    <ActionForm
                      action={resetTagFailures}
                      label="다시 시도 대상에 넣기"
                      pendingLabel="되돌리는 중…"
                      className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft"
                    />
                  </div>
                </div>
              )}
            </div>

            {/*
              사고사진 비전 분석 — 068. 위 코드 부여와 같은 성격(돈이 드는 LLM
              호출, 기본 꺼짐)이지만 연 50건 안팎이라 가볍게 둔다 — 비용 견적·
              소요 시간 추정·3연속실패 추적까지는 붙이지 않는다(코드 부여는
              5,884건 규모라 그런 장치가 필요했다).
            */}
            <div className="mt-5 border border-caution bg-caution-soft px-4 py-3">
              <div className="text-[13px] font-semibold text-caution">
                사고사진 비전 분석 — 비용이 드는 작업
              </div>

              {data.pendingPhotoVision === 0 ? (
                <p className="mt-1.5 text-[12px] text-ink-2">
                  아직 비전 분석하지 않은 사진이 없습니다.
                </p>
              ) : (
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                  웹 업로드가 추출·저장까지 마치고 분석을 기다리는 사고보고서가{' '}
                  <span className="addr tnum text-ink">
                    {data.pendingPhotoVision.toLocaleString()}건
                  </span>{' '}
                  있습니다. 사진에서 손상 흔적 같은 단서를 찾고, 제품 서술로 GPC
                  품목분류까지 조회합니다.
                </p>
              )}

              <div className="mt-3">
                {data.photoVisionOn ? (
                  <ActionForm
                    action={togglePhotoVision}
                    hidden={{ on: 'false' }}
                    label="멈추기"
                    pendingLabel="멈추는 중…"
                    className="border border-rule bg-surface px-4 py-2 text-[13px] hover:bg-rule-soft"
                  />
                ) : (
                  <ActionForm
                    action={togglePhotoVision}
                    hidden={{ on: 'true' }}
                    label="자동 실행 켜기"
                    pendingLabel="켜는 중…"
                    className="border border-caution bg-caution px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
                  />
                )}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                {data.photoVisionOn
                  ? '켜져 있습니다 — 1분마다 남은 것이 있는지 확인해 처리합니다.'
                  : '꺼져 있습니다. 켜 두면 1분마다 스스로 이어서 하고, 언제든 멈출 수 있습니다.'}
              </p>
            </div>
          </Section>

          {/* ── 2. 자동 작업 상세 ─────────────────────────────────── */}
          <Section
            id="ops-details"
            title="자동으로 도는 작업"
            lead="아래 작업들은 데이터베이스 안에서 스스로 돕니다. 웹사이트가 꺼져 있어도 돌아갑니다. 각 줄을 눌러 펼치면 그 작업이 왜 필요한지 나옵니다."
          >
            <div className="label grid grid-cols-[1fr_auto_auto_auto] gap-3 pb-2">
              <span>작업</span>
              <span>얼마나 자주</span>
              <span className="text-right">마지막 실행</span>
              <span className="text-right">상태</span>
            </div>
            {data.jobs.map((j) => {
              const info = JOB_INFO[j.jobname];
              return (
                <details key={j.jobname} className="border-t border-rule">
                  <summary className="grid cursor-pointer grid-cols-[1fr_auto_auto_auto] items-baseline gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px]">{info?.what ?? j.jobname}</div>
                      <div className="addr text-[11px] text-ink-3">{j.jobname}</div>
                    </div>
                    <span className="text-[11px] text-ink-3">{humanSchedule(j.schedule)}</span>
                    <span className="addr tnum text-right text-[11px] text-ink-3">
                      {when(j.last_at)}
                    </span>
                    <span className="text-right text-[11px]">
                      {!j.active ? (
                        <span className="text-ink-3">꺼짐</span>
                      ) : j.last_status === 'failed' ? (
                        <span className="text-halt">실패</span>
                      ) : (
                        <span className="text-measure">도는 중</span>
                      )}
                    </span>
                  </summary>
                  <p className="pb-3 text-[12px] leading-relaxed text-ink-2">
                    {info?.why ?? '설명이 아직 없습니다. 이 작업 이름을 개발자에게 알려 주세요.'}
                    {j.last_message && (
                      <span className="mt-1 block text-[11px] text-ink-3">
                        마지막 결과 — {j.last_message}
                      </span>
                    )}
                  </p>
                </details>
              );
            })}
          </Section>

          {/* ── 3. 의미 검색 준비 — 자료별 자세한 현황은 이 자리 하나뿐이다 ── */}
          <Section
            id="ops-embed"
            title="의미 검색 준비 현황"
            lead="위 「뜻으로 찾을 수 있게 자료를 준비한다」 작업이 어디까지 했는지입니다. 안전기준 조항 · 사고보고서 · 리콜의 문장을 미리 숫자로 바꿔 두어야, 낱말이 달라도 뜻이 같은 것을 찾아 줍니다."
          >
            {/* 진행 중인 일이 있으면 화면이 스스로 따라간다 */}
            <div className="mb-3">
              <AutoRefresh
                active={data.embed.some((e) => e.pending > 0 || e.in_flight > 0)}
                seconds={20}
                label="의미 검색 준비가 진행 중입니다 — 숫자가 저절로 갱신됩니다"
              />
            </div>
            <div className="label grid grid-cols-[1fr_repeat(4,minmax(48px,auto))] gap-3 pb-2">
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

            {/*
              무엇이 걸려 있는지 이름으로 짚어 준다 (담당자 요청, 2026-09-09)
              "문제가 있는 KC안전기준 명 또는 파일명을 알려주면 디버깅이 편해짐"
            */}
            {(data.noMaterialClause.length > 0 || data.noMaterialCase.length > 0) && (
              <details className="mt-4 border border-rule-soft">
                <summary className="cursor-pointer px-3 py-2 text-[12px] text-ink-2">
                  준비할 재료(검색용 문장)가 없는 것들 — 어느 기준·어느 건인지 보기
                </summary>
                <div className="border-t border-rule-soft px-3 py-3 text-[12px] leading-relaxed text-ink-2">
                  <p className="text-[11px] text-ink-3">
                    검색용 문장은 조항 본문·요약·낱말을 이어 붙여 만듭니다. 본문이 비어 있거나
                    표만 있는 조각은 재료가 나오지 않습니다. 아래는 그런 것들입니다.
                  </p>
                  {data.noMaterialClause.length > 0 && (
                    <div className="mt-3">
                      <div className="label pb-1">안전기준 조항</div>
                      {data.noMaterialClause.map((c) => (
                        <div key={c.display_name} className="flex items-baseline justify-between gap-3 border-t border-rule-soft py-1.5">
                          <span>
                            <span className="text-ink">{c.name ?? '명칭 없음'}</span>{' '}
                            <span className="addr text-[11px] text-ink-3">{c.display_name}</span>
                          </span>
                          <span className="addr tnum text-[11px] text-ink-3">{c.n.toLocaleString()}건</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {data.noMaterialCase.length > 0 && (
                    <div className="mt-4">
                      <div className="label pb-1">사고보고서 · 리콜</div>
                      {data.noMaterialCase.map((c) => (
                        <div key={c.id} className="border-t border-rule-soft py-1.5">
                          {/* 새 창으로 연다(2026-09-14) — 관리 화면을 보던 자리를 잃지 않게 */}
                          <Link
                            href={`/analysis/${c.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline decoration-rule underline-offset-2 hover:text-measure"
                          >
                            {TARGET_LABEL[c.source_type === 'ACCIDENT' ? 'accident' : 'recall']} #{c.id}
                          </Link>
                          <span className="text-ink-3"> — {c.label ?? '제목 없음'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </details>
            )}
          </Section>
        </>
      )}
      <PageToc items={TOC} />
    </>
  );
}
