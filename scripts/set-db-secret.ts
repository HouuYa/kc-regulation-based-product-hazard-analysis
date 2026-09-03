/**
 * .env.local 의 비밀값을 Supabase Vault(DB 안의 금고)에 넣는다
 *
 *   npm run embed:secret     OpenAI 키만
 *   npm run ops:secret       텔레그램 봇 토큰·대화 번호만
 *   npm run ops:test         텔레그램으로 시험 알림 1건 발송
 *
 * 왜 필요한가
 *   DB 안에서 도는 배치(020 임베딩, 023 알림)는 .env.local 을 읽을 수 없다.
 *   그렇다고 마이그레이션 파일에 값을 적으면 저장소에 올라간다(CLAUDE.md §7).
 *   그래서 값은 이 스크립트로 금고에 한 번 넣고, 배치는 금고에서 꺼내 쓴다.
 *
 * 값을 바꿨을 때도 다시 돌리면 된다 — 같은 이름이면 덮어쓴다.
 * 화면에 값을 찍지 않는다. 확인은 길이와 앞 네 글자로만 한다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { loadEnv, required, optional } from '../src/lib/env';

/** 금고에 값을 넣고, 배치가 실제로 꺼내 쓰는 경로로 되읽어 확인한다 */
async function put(name: string, value: string): Promise<void> {
  const db = getDb();

  const [existing] = await db<{ id: string }[]>`
    select id from vault.secrets where name = ${name}
  `;

  if (existing) {
    await db`select vault.update_secret(${existing.id}::uuid, ${value}, ${name})`;
  } else {
    await db`select vault.create_secret(${value}, ${name}, 'DB 안에서 도는 배치가 쓰는 값')`;
  }

  // 넣는 경로(vault.secrets)와 꺼내는 경로(vault.decrypted_secrets)가 다르므로
  // 되읽어 확인한다. 여기서 안 걸리면 배치가 돌 때 가서야 알게 된다.
  const [back] = await db<{ ok: boolean; head: string; len: number }[]>`
    select (decrypted_secret = ${value}) as ok,
           left(decrypted_secret, 4)     as head,
           length(decrypted_secret)      as len
    from vault.decrypted_secrets where name = ${name}
  `;

  if (!back?.ok) {
    throw new Error(`${name} 을 금고에 넣었으나 되읽지 못했습니다. 권한을 확인하세요.`);
  }
  console.log(`  ${name.padEnd(20)} ${existing ? '갱신' : '저장'} — ${back.head}... (${back.len}자)`);
}

async function setOpenai() {
  console.log('OpenAI');
  await put('openai_api_key', required('OPENAI_API_KEY'));
}

async function setTelegram() {
  loadEnv();
  console.log('텔레그램');

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      '.env.local 에 TELEGRAM_BOT_TOKEN 이 없습니다.\n' +
        '  텔레그램 @BotFather 에서 봇을 만들면 나오는 토큰입니다.\n' +
        '  (n8n 을 쓰고 계시면 그 워크플로의 Telegram 자격증명에 이미 들어 있는 값과 같습니다)',
    );
  }
  await put('telegram_bot_token', token);

  // 기본값은 docs/n8nErrorTrigger/Error Trigger.json 이 쓰던 대화 번호다.
  // 다른 대화로 받고 싶으면 .env.local 에 TELEGRAM_CHAT_ID 를 넣으면 된다.
  await put('telegram_chat_id', optional('TELEGRAM_CHAT_ID', '5185533472'));
}

/**
 * 정기 실행이 우리 사이트를 부를 때 쓰는 값
 *
 * 왜 세 곳에 같은 토큰이 필요한가
 *   .env.local   이 스크립트가 읽어 금고에 넣기 위해
 *   금고(Vault)  데이터베이스가 사이트를 부를 때 헤더에 실어 보내려고
 *   Netlify      사이트가 그 헤더를 검사하려고
 *   같은 값이어야 서로 맞는다. 하나라도 다르면 401 로 막힌다.
 */
async function setJobs() {
  loadEnv();
  console.log('정기 실행');

  const token = process.env.JOBS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      '.env.local 에 JOBS_TOKEN 이 없습니다.\n' +
        '  아무 긴 문자열이면 됩니다. 만들어 쓰려면:\n' +
        '    node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"\n' +
        '  같은 값을 Netlify 환경변수에도 JOBS_TOKEN 으로 넣어야 합니다.',
    );
  }
  await put('jobs_token', token);
  await put('site_base_url', optional('SITE_BASE_URL', 'https://kc-regulation-product-hazard-analysis.netlify.app'));
}

/** 시험 알림 — 토큰이 실제로 동작하는지 텔레그램 응답으로 확인한다 */
async function testAlert() {
  const db = getDb();

  const [{ sent }] = await db<{ sent: boolean }[]>`
    select public.ops_notify(
      '시험 알림',
      '이 메시지가 보이면 알림 경로가 정상입니다. 실제 문제가 생기면 같은 방식으로 알려 드립니다.',
      interval '0'
    ) as sent
  `;

  if (!sent) {
    throw new Error('보내지 못했습니다. 금고에 텔레그램 값이 없습니다 — npm run ops:secret 을 먼저 실행하세요.');
  }
  console.log('발송 요청 완료. 텔레그램 응답을 기다립니다...');

  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const [row] = await db<{ code: number | null; body: string | null }[]>`
      select resp.status_code as code, left(resp.content, 200) as body
      from public.ops_alert a
      join net._http_response resp on resp.id = a.request_id
      where a.kind = '시험 알림'
      order by a.sent_at desc limit 1
    `;
    if (row?.code != null) {
      if (row.code === 200) {
        console.log('성공: 텔레그램이 메시지를 받았습니다. 휴대전화를 확인하세요.');
      } else {
        console.error(`실패: 텔레그램이 HTTP ${row.code} 를 반환했습니다.`);
        console.error(`  ${row.body}`);
        process.exitCode = 1;
      }
      return;
    }
  }
  console.warn('30초 안에 응답이 오지 않았습니다. npm run ops:status 로 나중에 확인하세요.');
}

async function main() {
  const arg = process.argv[2] ?? 'all';

  if (arg === 'test') return testAlert();

  if (arg === 'all' || arg === 'openai') await setOpenai();
  if (arg === 'all' || arg === 'ops' || arg === 'telegram') await setTelegram();
  if (arg === 'all' || arg === 'ops' || arg === 'jobs') await setJobs();

  console.log('');
  console.log('금고에 넣었습니다. 값 자체는 저장소에 올라가지 않습니다.');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
