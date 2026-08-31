/**
 * 데이터베이스 접근 — 서버 전용 직접 Postgres 연결
 *
 * 왜 supabase-js(PostgREST) 가 아니라 직접 연결인가
 *
 *  1) 2026-04-28 부터 Supabase 는 public 스키마의 신규 테이블을 Data API 에
 *     자동 노출하지 않는다. service_role 조차 명시적 GRANT 가 있어야 닿는다.
 *     우리 표는 서버만 쓰므로 아예 노출하지 않는 편이 낫고, 그러면 PostgREST 경로는
 *     쓸 수 없다. 설계문서 1.3.3 "프론트엔드는 DB 에 직접 붙지 않는다" 와도 맞는다.
 *
 *  2) 조항 13,501건 · 임베딩 1536차원을 다루는 배치에는 대량 삽입이 필요하다.
 *     PostgREST 로 나눠 보내는 것보다 한 트랜잭션에 밀어 넣는 쪽이 빠르고 안전하다.
 *
 *  3) clause_hybrid_search 는 vector(1536) 인자를 받는다. SQL 로 직접 부르면
 *     타입 변환을 우리가 통제할 수 있다.
 *
 * Supabase 클라이언트는 Storage(원본 파일 보관, §7.1 원본층)에만 쓴다.
 */

import postgres, { type Sql } from 'postgres';
import { required } from './env.js';

let sql: Sql | null = null;

export function getDb(): Sql {
  if (sql) return sql;
  sql = postgres(required('DATABASE_URL'), {
    // 배치와 웹 요청이 같은 풀을 쓴다. 0단계 규모에서는 이 정도면 충분하다
    max: 5,
    idle_timeout: 20,
    onnotice: () => {},
    // 조항 본문에 특수문자가 많아 파싱 비용을 줄인다
    prepare: false,
  });
  return sql;
}

export async function closeDb(): Promise<void> {
  if (!sql) return;
  await sql.end();
  sql = null;
}

/**
 * 대량 삽입을 나눠 넣는다.
 *
 * 한 번에 수천 행을 보내면 매개변수 한도(65535개)에 걸린다.
 * 열 개수로 묶음 크기를 정해 한도 안에 들어오게 한다.
 */
export async function insertMany(
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();

  // Postgres 매개변수 한도 65535. 여유를 두고 60000 으로 잡는다
  const chunkSize = Math.max(1, Math.floor(60000 / columns.length));
  let inserted = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    try {
      await db`insert into ${db(table)} ${db(chunk as never, ...(columns as string[]))}`;
      inserted += chunk.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${table} 적재 실패 (행 ${i}~${i + chunk.length - 1}): ${msg}`);
    }
  }
  return inserted;
}

/** vector(1536) 리터럴로 바꾼다. pgvector 는 '[0.1,0.2,...]' 형식을 받는다 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
