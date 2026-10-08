'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';

/**
 * 운영 화면의 조작
 *
 * 전부 여러 번 눌러도 안전하다(멱등). 자동 작업이 어차피 1분·5분마다 같은 일을
 * 하기 때문에, 이 버튼들은 새 일을 만드는 것이 아니라 다음 차례를 앞당길 뿐이다.
 * 담당자가 "지금 됐나?"를 확인하려고 1분을 기다리지 않아도 되게 한다.
 *
 * 결과를 어떻게 알리는가 (2026-09-03 방식 변경)
 *   전에는 결과를 주소줄(?done=)에 실어 화면 맨 위에 띠로 그렸다. 그런데
 *   운영 화면은 길어서, 아래쪽 버튼을 누르면 그 띠가 보이지 않았다. 게다가 주소가
 *   바뀔 때마다 무거운 조회가 통째로 다시 돌아 화면이 눈에 띄게 깜빡였다
 *   (담당자 지적: "화면이 깜빡입니다").
 *
 *   그래서 문장만 돌려주고, 화면은 ActionForm 이 누른 자리에 붙여 보여 준다.
 *   숫자는 router.refresh() 로 조용히 새로 읽는다 — 스크롤도 그대로다.
 *
 * redirect() 를 쓰지 않으므로 try/catch 로 신호가 삼켜지던 문제도 함께 사라졌다.
 */

/** 1분을 기다리지 않고 의미 검색 준비를 지금 한 번 돌린다 */
export async function runEmbedTick(): Promise<string> {
  try {
    const [row] = await getDb()<{ r: string }[]>`select public.embed_tick() as r`;
    revalidatePath('/ops');
    return `실행했습니다 — ${row.r}`;
  } catch (e) {
    return `실행에 실패했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/**
 * 보류된 건을 다시 시도 대상으로 되돌린다
 *
 * 다섯 번 실패해 세워 둔 자료는 사람이 원인을 고치기 전에는 다시 시도해도 또
 * 실패한다. 그래서 자동으로 풀지 않고 버튼으로 둔다 — "고쳤으니 다시 해 봐"라고
 * 말하는 자리다.
 */
export async function retryParked(): Promise<string> {
  try {
    const rows = await getDb()`
      delete from public.embed_queue where status = 'failed' and attempts >= 5
    `;
    revalidatePath('/ops');
    return `보류 ${rows.count}건을 다시 시도하도록 되돌렸습니다. 1분 안에 다시 해 봅니다.`;
  } catch (e) {
    return `되돌리지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/** 알림 경로가 살아 있는지 실제 메시지를 보내 확인한다 */
export async function sendTestAlert(): Promise<string> {
  try {
    const [row] = await getDb()<{ sent: boolean }[]>`
      select public.ops_notify(
        '시험 알림',
        '이 메시지가 보이면 알림 경로가 정상입니다. 실제 문제가 생기면 같은 방식으로 알려 드립니다.',
        interval '0'
      ) as sent
    `;
    revalidatePath('/ops');
    return row.sent
      ? '보냈습니다. 텔레그램을 확인해 보세요.'
      : '보내지 못했습니다. 텔레그램 봇 토큰이 비밀값 보관함에 없습니다.';
  } catch (e) {
    return `보내지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/**
 * 담당자가 쓴 말을 그대로 보낸다
 *
 * 쿨다운을 두지 않는다 — 자동 알림은 같은 말을 반복하지 않도록 6시간을 두지만,
 * 사람이 직접 누른 것은 그 사람이 보내려고 누른 것이다. 막을 이유가 없다.
 */
export async function sendCustomMessage(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const text = String(formData.get('message') ?? '').trim();
  if (!text) return '보낼 내용을 적어 주세요.';

  try {
    const [row] = await getDb()<{ sent: boolean }[]>`
      select public.ops_notify('담당자 메모', ${text}, interval '0') as sent
    `;
    revalidatePath('/ops');
    return row.sent
      ? '보냈습니다.'
      : '보내지 못했습니다. 텔레그램 봇 토큰이 비밀값 보관함에 없습니다.';
  } catch (e) {
    return `보내지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/**
 * 정기 작업을 기다리지 않고 지금 부른다
 *
 * 정기 작업은 이제(028) 2~5분마다 조금씩 도는 구간 방식이지만, 그래도 한
 * 바퀴(recalls-fetch는 약 26.7시간)를 다 돌아야 특정 구간이 잡힌다. 지금 막
 * 들어온 자료를 그만큼 기다릴 이유는 없으므로 버튼도 함께 둔다. 여러 번
 * 눌러도 안전하다(같은 자료를 다시 넣지 않는다).
 */
export async function runJobNow(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const job = String(formData.get('job') ?? '');
  if (!job) return '무슨 작업인지 알 수 없습니다.';

  const label = job === 'recalls-fetch' ? '리콜 수집' : '안전기준 폴더 확인';
  try {
    // run_job(job)을 인자 없이 부르면 리콜 수집이 기본 limit=20으로 돌아
    // 034가 실측한 30초 제한을 항상 넘겨 504가 난다(067). run_job_now는
    // recalls-fetch에 cron과 같은 안전한 구간(limit=3)을 강제한다.
    await getDb()`select public.run_job_now(${job})`;
    revalidatePath('/ops');
    return `${label}을(를) 요청했습니다. 결과는 몇 분 안에 「최근 처리」에 나타납니다.`;
  } catch (e) {
    return `요청하지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/**
 * 코드 부여 자동 실행 켜고 끄기
 *
 * 켜면 1분마다 스스로 이어서 하고, 다 끝나면 저절로 꺼지면서 텔레그램으로 알린다.
 * 담당자는 켜 두고 잊으면 된다.
 *
 * 상태를 따로 저장하지 않고 cron 작업 자체를 켜고 끈다 — 상태가 한 군데에만
 * 있어야 "화면은 켜졌다는데 실제로는 안 도는" 어긋남이 생기지 않는다.
 */
export async function toggleAutoTagging(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const on = String(formData.get('on')) === 'true';
  try {
    await getDb()`select public.set_auto_tagging(${on})`;
    revalidatePath('/ops');
    return on
      ? '켰습니다. 1분마다 스스로 이어서 하고, 다 끝나면 저절로 꺼지면서 텔레그램으로 알려 드립니다. 이 화면을 닫아도 계속 돕니다.'
      : '껐습니다. 지금까지 처리한 것은 그대로 남습니다.';
  } catch (e) {
    return `바꾸지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/**
 * 사고사진 비전 분석 자동 실행 켜고 끄기 (068)
 *
 * toggleAutoTagging과 같은 이유로 cron 작업 자체를 켜고 끈다 — 상태를 따로
 * 저장하면 "화면은 켜졌다는데 실제로는 안 도는" 어긋남이 생길 수 있다.
 * 다만 이쪽은 "다 끝나면 스스로 꺼짐"이 없다 — 사고사진은 연 50건 안팎이라
 * 계속 켜 둬도 남은 것이 없으면 그냥 아무 일도 안 하고 넘어간다.
 */
export async function togglePhotoVision(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const on = String(formData.get('on')) === 'true';
  try {
    await getDb()`select public.set_photo_vision(${on})`;
    revalidatePath('/ops');
    return on
      ? '켰습니다. 1분마다 아직 분석하지 않은 사진이 있는지 확인해 처리합니다.'
      : '껐습니다. 지금까지 분석한 것은 그대로 남습니다.';
  } catch (e) {
    return `바꾸지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}

/**
 * 세 번 연속 실패해 넘긴 조항을 다시 대상에 넣는다 (029)
 *
 * 실패 원인이 일시적인 것(모델 장애, 요청 한도)이었다면 고친 뒤 다시 돌리면 된다.
 * 되돌릴 길이 없으면 한 번 실패한 조항은 영영 코드가 붙지 않는다.
 *
 * 자동 실행이 꺼져 있을 수 있으므로 켜라는 안내를 함께 준다 — 되돌리기만 하고
 * 아무 일도 일어나지 않으면 담당자는 버튼이 안 먹었다고 생각한다.
 */
export async function resetTagFailures(): Promise<string> {
  try {
    const [row] = await getDb()<{ n: number }[]>`
      select public.reset_tag_failures() as n
    `;
    revalidatePath('/ops');
    if (row.n === 0) return '되돌릴 조항이 없습니다.';
    return `${row.n}건을 다시 대상에 넣었습니다. 자동 실행을 켜면 다시 시도합니다.`;
  } catch (e) {
    return `되돌리지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}
