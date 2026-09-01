/**
 * Supabase 클라이언트 — Storage 전용
 *
 * 표 접근은 여기가 아니라 src/lib/db.ts(직접 Postgres)로 한다.
 * 2026-04-28 부터 신규 public 테이블은 Data API 에 자동 노출되지 않고 service_role 도
 * 명시적 GRANT 가 필요한데, 우리 표는 애초에 노출할 이유가 없기 때문이다.
 *
 * 이 클라이언트가 맡는 것은 원본 파일 보관 한 가지다(§7.1 원본층 — 파싱 JSON,
 * 사고보고서 PDF). 원본은 불변이고 덮어쓰지 않는다. 이것이 사라지면 아무것도
 * 재생성할 수 없다.
 *
 * service_role 키는 절대 브라우저로 나가면 안 된다.
 * 파일명이 server.ts 인 것과 NEXT_PUBLIC_ 접두사가 없는 것이 그 방어선이다.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { required } from '../env';

export const ORIGINAL_BUCKET = 'originals';

let client: SupabaseClient | null = null;

export function getStorageClient(): SupabaseClient {
  if (client) return client;
  client = createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return client;
}

/**
 * 파일명에서 확장자만 안전하게 뽑는다. 확장자는 거의 항상 ASCII(pdf, md, json)라
 * 키에 넣어도 안전하다. 못 뽑으면 빈 문자열 — 확장자 없이 저장된다.
 */
function safeExt(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  return m ? `.${m[1].toLowerCase()}` : '';
}

/**
 * 원본 파일을 보관한다.
 *
 * 경로에는 내용 해시만 쓰고 원본 파일명은 넣지 않는다.
 *
 *   실제로 겪은 문제: 사고조사보고서 파일명이 전부 한글이라
 *   ("가습기 사고조사 보고서_비식별화_f.pdf") 경로에 그대로 넣었더니
 *   Supabase Storage 가 "Invalid key" 로 5건 전부 거부했다. 특수문자(★, 괄호,
 *   공백) 때문이 아니라 **한글 자체**가 원인이었다 — 한글만 남긴 키("가습기.txt")도
 *   똑같이 거부됐다. Storage 키는 안전한 ASCII 만 허용한다.
 *
 *   사람이 읽는 파일명은 이미 source_file.filename 컬럼에 그대로 저장돼 있으므로
 *   키에서 빼도 잃는 정보가 없다. 해시가 이미 유일성을 보장하고, 확장자만
 *   붙여 두면 다운로드했을 때 어떤 파일인지는 여전히 알 수 있다.
 */
export async function putOriginal(
  kind: 'accident' | 'codebook' | 'standard',
  sha256: string,
  filename: string,
  body: Uint8Array | Blob,
  contentType: string,
): Promise<string> {
  const path = `${kind}/${sha256.slice(0, 2)}/${sha256}${safeExt(filename)}`;
  const { error } = await getStorageClient()
    .storage.from(ORIGINAL_BUCKET)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`원본 보관 실패 (${filename}): ${error.message}`);
  return path;
}
