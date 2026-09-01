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
 * 원본 파일을 보관한다.
 *
 * 경로에 내용 해시를 넣는다. 같은 파일을 다시 올려도 같은 자리에 놓이므로
 * 사본이 늘지 않고, 파일명이 바뀌어도 같은 내용임을 알 수 있다.
 */
export async function putOriginal(
  kind: 'accident' | 'codebook' | 'standard',
  sha256: string,
  filename: string,
  body: Uint8Array | Blob,
  contentType: string,
): Promise<string> {
  const path = `${kind}/${sha256.slice(0, 2)}/${sha256}/${filename}`;
  const { error } = await getStorageClient()
    .storage.from(ORIGINAL_BUCKET)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`원본 보관 실패 (${filename}): ${error.message}`);
  return path;
}
