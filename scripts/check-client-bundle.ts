/**
 * 브라우저로 나가는 번들에 비밀값이 섞였는지 검사한다
 *
 *   npm run check:bundle        (npx next build 를 먼저 돌려야 한다)
 *
 * 왜 필요한가 (02_1차 보완 및 구현 설계서 §9, 원 계획서 P2)
 *   src/lib 의 몇 파일은 자격증명을 읽는다 — DATABASE_URL, 협회 리콜 원본 표의
 *   sb_secret_* 키, 원본 보관용 service_role 키. 이 파일들이 서버에서만 돈다는
 *   보장은 지금까지 "파일 이름"과 "NEXT_PUBLIC_ 접두사를 안 쓴다"는 규칙뿐이었다.
 *   규칙은 강제가 아니다 — 클라이언트 컴포넌트가 한 줄만 잘못 import 해도 그 값이
 *   브라우저 번들에 들어가고, 빌드는 성공한다. 조용히 새는 종류의 사고다.
 *
 * 왜 'server-only' 패키지를 쓰지 않았나 (실제로 해 보고 되돌렸다)
 *   React 의 server-only 패키지가 정확히 이 일을 한다. 넣어 봤더니 CLI 가 전부
 *   죽었다. 그 패키지의 기본 진입점은 Node 에서 무조건 예외를 던지고, empty 모듈은
 *   react-server 조건에서만 선택되기 때문이다.
 *
 *     Error: This module cannot be imported from a Client Component module.
 *
 *   이 저장소는 명령줄과 화면이 src/lib 를 함께 쓴다(CLAUDE.md §9). db.ts 와
 *   env.ts 를 import 하는 스크립트가 19개다. 그것들을 다 죽이면서 얻을 보호가 아니다.
 *
 *   그래서 원 계획서가 원래 적어 둔 방식으로 돌아왔다 — "빌드 산출물을 검사한다".
 *   import 를 막는 대신, 실제로 샜는지를 결과물에서 확인한다.
 *
 * 두 가지로 본다
 *   1) 값 검사   .env.local 에 실제로 들어 있는 비밀값 문자열이 번들에 있는가.
 *                가장 확실하지만 자격증명이 있는 곳에서만 쓸 수 있다.
 *   2) 모양 검사 postgresql:// · sb_secret_ · service_role 처럼 비밀값의 생김새.
 *                자격증명이 없는 CI 에서도 돈다.
 *
 * 찾아도 값 자체는 절대 출력하지 않는다. 어느 파일에서 어떤 종류가 나왔는지만 적는다.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../src/lib/env';

/** 브라우저로 실제 전송되는 것들. .next/server 는 서버에만 있으므로 보지 않는다 */
const CLIENT_DIRS = ['.next/static'];

/** 이 이름의 환경변수 값이 번들에 있으면 안 된다 */
const SECRET_ENV = [
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'RECALL_SOURCE_SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GPC_LOOKUP_ANON_KEY',
  'JOBS_TOKEN',
  'STANDARDS_SYNC_TOKEN',
  'SITE_AUTH_PASSWORD',
  'TELEGRAM_BOT_TOKEN',
];

/** 자격증명이 없는 환경에서도 잡을 수 있는 생김새 */
const SHAPES: Array<{ name: string; re: RegExp }> = [
  { name: 'PostgreSQL 접속 문자열', re: /postgres(?:ql)?:\/\/[^\s"']{10,}/ },
  { name: 'Supabase secret 키', re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'service_role JWT', re: /"role"\s*:\s*"service_role"/ },
  { name: 'OpenAI 키', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: '텔레그램 봇 토큰', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}/ },
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|json|css|map)$/.test(name)) out.push(p);
  }
  return out;
}

function main() {
  loadEnv();

  const files = CLIENT_DIRS.flatMap((d) => walk(d));
  if (files.length === 0) {
    console.error('검사할 파일이 없습니다. npx next build 를 먼저 돌려 주세요.');
    process.exit(1);
  }

  // 너무 짧은 값은 우연히 겹칠 수 있어 검사하지 않는다("1" 같은 것)
  const secrets = SECRET_ENV
    .map((name) => ({ name, value: process.env[name]?.trim() ?? '' }))
    .filter((s) => s.value.length >= 12);

  const hits: string[] = [];

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const s of secrets) {
      if (text.includes(s.value)) hits.push(`${file} — 환경변수 ${s.name} 의 값이 그대로 들어 있습니다`);
    }
    for (const shape of SHAPES) {
      if (shape.re.test(text)) hits.push(`${file} — ${shape.name} 로 보이는 문자열이 있습니다`);
    }
  }

  console.log(`검사 대상 ${files.length}개 파일 (${CLIENT_DIRS.join(', ')})`);
  console.log(`값 대조 ${secrets.length}종 · 모양 대조 ${SHAPES.length}종`);

  if (hits.length === 0) {
    console.log('');
    console.log('브라우저 번들에서 비밀값을 찾지 못했습니다.');
    if (secrets.length === 0) {
      console.log('참고: 자격증명이 설정돼 있지 않아 모양 대조만 했습니다(CI 에서는 정상입니다).');
    }
    return;
  }

  console.error('');
  console.error('브라우저로 나가는 번들에 비밀값이 섞여 있습니다:');
  // 값은 절대 적지 않는다 — 오류 메시지가 로그에 남으면 그것이 또 하나의 유출이다
  for (const h of [...new Set(hits)]) console.error(`  ${h}`);
  console.error('');
  console.error('그 값을 읽는 파일이 클라이언트 컴포넌트에서 import 되고 있지 않은지 확인하세요.');
  process.exit(1);
}

main();
