'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';

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
