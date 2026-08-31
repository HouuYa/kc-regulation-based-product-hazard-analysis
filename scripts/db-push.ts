/**
 * 마이그레이션 적용
 *
 *   npm run db:push              아직 적용되지 않은 파일만 순서대로 실행
 *   npm run db:push -- --dry     실행하지 않고 순서와 대상만 출력
 *
 * 적용 순서가 중요하다.
 *   codebook/sql/*   코드북 스키마와 조회 함수 (본 체계가 참조한다)
 *   supabase/migrations/*  본 체계 스키마
 *
 * 적용 이력을 public.schema_migration 에 남겨 같은 파일을 두 번 돌리지 않는다.
 * 파일 내용이 바뀌면 해시가 달라지므로 그 사실을 경고한다 — 이미 적용된 마이그레이션을
 * 수정하는 것은 재현성을 깨뜨리는 일이라 조용히 넘어가면 안 된다.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import postgres from 'postgres';
import { required } from '../src/lib/env.js';

const ROOT = join(import.meta.dirname, '..');
const SOURCES = [
  { dir: join(ROOT, 'codebook', 'sql'), prefix: 'codebook' },
  { dir: join(ROOT, 'supabase', 'migrations'), prefix: 'main' },
];

interface Migration {
  name: string;
  path: string;
  sql: string;
  sha256: string;
}

function collect(): Migration[] {
  const out: Migration[] = [];
  for (const { dir, prefix } of SOURCES) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const path = join(dir, f);
      const sql = readFileSync(path, 'utf8');
      out.push({
        name: `${prefix}/${f}`,
        path,
        sql,
        sha256: createHash('sha256').update(sql).digest('hex'),
      });
    }
  }
  return out;
}

async function main() {
  const migrations = collect();
  const dry = process.argv.includes('--dry');

  if (dry) {
    console.log('적용 순서 (실행하지 않음)');
    for (const m of migrations) console.log('  ', m.name, `(${m.sql.length.toLocaleString()} bytes)`);
    return;
  }

  const sql = postgres(required('DATABASE_URL'), { max: 1, onnotice: () => {} });

  try {
    await sql`
      create table if not exists public.schema_migration (
        name        text primary key,
        sha256      text not null,
        applied_at  timestamptz not null default now()
      )
    `;

    const applied = await sql<{ name: string; sha256: string }[]>`
      select name, sha256 from public.schema_migration
    `;
    const appliedMap = new Map(applied.map((r) => [r.name, r.sha256]));

    let ran = 0;
    for (const m of migrations) {
      const prev = appliedMap.get(m.name);
      if (prev === m.sha256) {
        console.log('건너뜀   ', m.name);
        continue;
      }
      if (prev && prev !== m.sha256) {
        // 이미 적용된 마이그레이션의 내용이 바뀌었다. 조용히 다시 돌리지 않는다.
        console.warn(
          `경고     ${m.name} — 이미 적용됐으나 내용이 바뀌었습니다.\n` +
            '         새 파일로 분리하는 것이 원칙입니다. 그래도 다시 실행합니다.',
        );
      }

      process.stdout.write(`적용 중  ${m.name} ... `);
      // 한 파일을 한 트랜잭션으로 — 중간에 실패하면 그 파일은 통째로 되돌아간다
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`
          insert into public.schema_migration (name, sha256)
          values (${m.name}, ${m.sha256})
          on conflict (name) do update set sha256 = excluded.sha256, applied_at = now()
        `;
      });
      console.log('완료');
      ran++;
    }

    console.log('');
    console.log(ran === 0 ? '적용할 마이그레이션이 없습니다.' : `${ran}개 적용 완료.`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error('');
  console.error('실패:', e instanceof Error ? e.message : e);
  process.exit(1);
});
