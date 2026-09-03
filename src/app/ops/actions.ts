'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { runTagging, countTaggable } from '@/lib/standards/tag-run';

/**
 * 운영 화면의 조작 — 셋 다 "기다리지 않고 지금 하기"에 해당한다
 *
 * 세 가지 모두 여러 번 눌러도 안전하다(멱등). 자동 배치가 어차피 1분·5분마다
 * 같은 일을 하기 때문에, 이 버튼들은 새로운 일을 만드는 것이 아니라 다음 주기를
 * 앞당길 뿐이다. 담당자가 "지금 됐나?"를 확인하려고 1분을 기다리지 않아도 되게 한다.
 *
 * 결과를 어떻게 알리는가
 *   이 프로젝트의 다른 화면들처럼 클라이언트 자바스크립트 없이 간다.
 *   작업 결과를 주소줄(?done=)에 실어 되돌려 보내고, 화면이 그것을 띠로 그린다.
 */

function back(message: string): never {
  revalidatePath('/ops');
  redirect(`/ops?done=${encodeURIComponent(message)}`);
}

/** 1분을 기다리지 않고 임베딩 배치를 지금 한 번 돌린다 */
export async function runEmbedTick(): Promise<void> {
  let result: string;
  try {
    const [row] = await getDb()<{ r: string }[]>`select public.embed_tick() as r`;
    result = row.r;
  } catch (e) {
    back(`배치 실행에 실패했습니다 — ${e instanceof Error ? e.message : e}`);
  }
  back(`배치를 실행했습니다 — ${result}`);
}

/**
 * 보류된 건을 다시 시도 대상으로 되돌린다
 *
 * 5회 실패해 세워 둔 행은 사람이 원인을 고치기 전에는 다시 시도해 봐야 또 실패한다.
 * 그래서 자동으로 풀지 않고 버튼으로 둔다 — "고쳤으니 다시 해 봐"라고 말하는 자리다.
 */
export async function retryParked(): Promise<void> {
  const db = getDb();
  const rows = await db`
    delete from public.embed_queue where status = 'failed' and attempts >= 5
  `;
  back(`보류 ${rows.count}건을 다시 시도하도록 되돌렸습니다. 1분 안에 재시도합니다.`);
}

/** 알림 경로가 살아 있는지 실제 메시지를 보내 확인한다 */
export async function sendTestAlert(): Promise<void> {
  const [row] = await getDb()<{ sent: boolean }[]>`
    select public.ops_notify(
      '시험 알림',
      '이 메시지가 보이면 알림 경로가 정상입니다. 실제 문제가 생기면 같은 방식으로 알려 드립니다.',
      interval '0'
    ) as sent
  `;
  back(
    row.sent
      ? '시험 알림을 보냈습니다. 텔레그램을 확인하세요 — 몇 초 뒤 아래 발송 기록에 전달 결과가 남습니다.'
      : '보내지 못했습니다. 텔레그램 봇 토큰이 금고에 없습니다 — 아래 「알림 설정」을 보세요.',
  );
}

/**
 * 알림 보내기를 넓게 쓴다 (담당자 요청)
 *
 * 전에는 정해진 시험 문구만 보낼 수 있었다. 담당자가 직접 쓴 말을 보낼 수 있으면
 * 쓰임이 늘어난다 — 동료에게 메모를 남기거나, 알림 경로가 살아 있는지 확인하거나,
 * 자리를 비우기 전에 상태를 스스로에게 보내 두거나.
 *
 * 쿨다운을 두지 않는다
 *   자동 알림은 같은 말을 반복하지 않도록 6시간 쿨다운이 있지만, 사람이 직접
 *   누른 것은 그 사람이 보내려고 누른 것이다. 막을 이유가 없다.
 */
export async function sendCustomMessage(formData: FormData): Promise<void> {
  const text = String(formData.get('message') ?? '').trim();
  if (!text) back('보낼 내용을 입력해 주세요.');

  const [row] = await getDb()<{ sent: boolean }[]>`
    select public.ops_notify('담당자 메모', ${text}, interval '0') as sent
  `;
  back(
    row.sent
      ? '보냈습니다. 아래 발송 기록에서 전달 결과를 확인할 수 있습니다.'
      : '보내지 못했습니다. 텔레그램 봇 토큰이 비밀값 보관함에 없습니다.',
  );
}

/**
 * 위해요인 코드 부여를 조금 실행한다
 *
 * 왜 "조금"인가
 *   남은 요건 조항은 5,902건이고, 한 건마다 AI 를 3~4번 순서대로 부른다.
 *   웹 요청은 수십 초 안에 끝나야 하므로 한 번에 다 돌 수가 없다.
 *   그래서 시간으로 끊고, 남은 것은 다음에 누를 때 이어서 한다.
 *   급하면 터미널에서 `npm run tag` 로 한 번에 돌리는 편이 훨씬 빠르다.
 *
 * 돈이 드는 유일한 버튼이다
 *   화면이 누르기 전에 남은 건수와 예상 비용을 보여 준다. 자동 주기로 걸지 않은
 *   것도 같은 이유다 — 돈 쓰는 결정은 사람이 해야 한다.
 */
export async function runTagChunk(): Promise<void> {
  // back() 을 try 안에서 부르면 안 된다.
  //
  // redirect() 는 정상 흐름을 끊기 위해 특별한 오류를 던지는 방식으로 동작한다.
  // 그것을 catch 가 잡아 버리면 "성공했는데 실패했다"고 말하게 되고, 최악의 경우
  // 화면이 아무 반응도 하지 않는다. 그래서 결과 문장만 만들어 두고 밖에서 보낸다.
  let message: string;
  try {
    const r = await runTagging({ timeBudgetMs: 18_000 });
    const after = await countTaggable();

    message =
      r.target === 0
        ? '코드를 부여할 요건 조항이 남아 있지 않습니다.'
        : `코드 부여 ${r.ok}건 완료${r.fail ? ` (실패 ${r.fail}건)` : ''}. ` +
          `남은 조항 ${after.toLocaleString()}건` +
          `${after > 0 ? ' — 이어서 하려면 다시 누르세요.' : ' — 모두 끝났습니다.'}`;
  } catch (e) {
    message = `코드 부여에 실패했습니다 — ${e instanceof Error ? e.message : e}`;
  }
  back(message);
}

/**
 * 정기 작업을 기다리지 않고 지금 부른다
 *
 * 리콜 수집과 기준 동기화는 하루 1회 새벽에 자동으로 돈다. 새 자료가 들어온 것을
 * 알고 있는데 내일까지 기다릴 이유는 없으므로 버튼도 함께 둔다.
 * 둘 다 여러 번 눌러도 안전하다(같은 자료를 다시 넣지 않는다).
 */
export async function runJobNow(formData: FormData): Promise<void> {
  const job = String(formData.get('job') ?? '');
  if (!job) return;

  const label = job === 'recalls-fetch' ? '리콜 수집' : '안전기준 폴더 동기화';
  let message: string;
  try {
    await getDb()`select public.run_job(${job})`;
    message = `${label}을(를) 요청했습니다. 결과는 몇 분 안에 아래 「최근 처리」에 나타납니다.`;
  } catch (e) {
    message = `${label} 요청에 실패했습니다 — ${e instanceof Error ? e.message : e}`;
  }
  back(message); // redirect() 는 try 밖에서 — 위 runTagChunk 주석 참고
}

/**
 * 코드 부여 자동 실행 켜고 끄기 (담당자 요청)
 *
 * "npm run tag 도 웹페이지에서 클릭하면 자동으로 돌리게 해줘"
 *
 * 켜면 1분마다 25초어치씩 스스로 이어서 하고, 다 끝나면 저절로 꺼지면서
 * 텔레그램으로 알린다. 담당자는 켜 두고 잊으면 된다.
 *
 * 상태를 따로 저장하지 않고 cron 작업 자체를 켜고 끈다 — 상태가 한 군데에만
 * 있어야 "화면은 켜졌다는데 실제로는 안 도는" 어긋남이 생기지 않는다.
 */
export async function toggleAutoTagging(formData: FormData): Promise<void> {
  const on = String(formData.get('on')) === 'true';
  let message: string;
  try {
    await getDb()`select public.set_auto_tagging(${on})`;
    message = on
      ? '자동 실행을 켰습니다. 1분마다 스스로 이어서 하고, 다 끝나면 저절로 꺼지면서 텔레그램으로 알려 드립니다. 이 화면을 닫아도 계속 돕니다.'
      : '자동 실행을 껐습니다. 지금까지 처리된 것은 그대로 남습니다.';
  } catch (e) {
    message = `설정에 실패했습니다 — ${e instanceof Error ? e.message : e}`;
  }
  back(message); // redirect() 는 try 밖에서 — 위 runTagChunk 주석 참고
}
