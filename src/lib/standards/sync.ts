/**
 * 안전기준 폴더 동기화 — 새 JSON 감지 · 비교 · 개정 처리
 *
 * scripts/load-standards.ts 는 "이미 있으면 건너뛴다(같은 해시)"만 판단했다.
 * 이 모듈은 그보다 한 단계 더 본다 — 협회가 같은 기준의 **개정판**을 새 파일로
 * 내려 줄 수 있다는 전제를 반영한다.
 *
 * 판정 기준은 파일 해시가 아니라 표시명(display_name)이다.
 *   같은 표시명 + 같은 해시   → UNCHANGED  (아무 것도 안 함)
 *   같은 표시명 + 다른 해시   → UPDATED    (옛 판을 is_current=false 로 내리고
 *                                          새 판을 새 standard 행으로 넣는다)
 *   표시명이 없음            → NEW        (새 기준으로 적재)
 *
 * 옛 판을 지우지 않는 이유 (§2.2 표 설계)
 *   "조항은 개정되면 새 행을 만들고, 옛 행은 지우지 않는다." 옛 판에 달린 태깅·
 *   매칭 기록·담당자 판단은 판단층(§7.1)이라 절대 사라지면 안 된다. 그래서
 *   UPDATED 는 delete 가 아니라 is_current 플래그 전환 + 새 행 삽입이다.
 *
 * 새 판의 조항은 아직 태깅되지 않은 상태로 들어온다. 재태깅 대상 규모를
 * 확인하려면 sync 결과의 clauseCount 를 보고 npm run tag 를 다시 돌리면 된다.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db';
import { parseStandardJson } from './parse-result-json';
import { insertParsedStandard } from './load';

export type SyncStatus = 'new' | 'updated' | 'unchanged' | 'error';

export interface SyncFileResult {
  file: string;
  displayName: string | null;
  status: SyncStatus;
  standardId?: number;
  previousStandardId?: number;
  clauseCount?: number;
  testMethodLinkCount?: number;
  message?: string;
}

export interface SyncOptions {
  /** KC안전기준/ 폴더 경로. 기본값은 저장소 루트의 KC안전기준/ */
  dir?: string;
  /** 파일명에 포함된 문자열로만 좁혀 돈다 (부분 동기화) */
  only?: string;
}

/**
 * KC안전기준/ 폴더 위치
 *
 * 두 방식이 필요한 이유 (실측으로 확인, 2026-09-03)
 *   명령줄에서는 이 파일의 위치를 기준으로 거슬러 올라가면 된다.
 *   그런데 웹 서버(Next.js) 안에서는 이 파일이 번들로 묶여 import.meta.dirname 이
 *   undefined 가 되고, join() 이 "path argument must be of type string" 으로 터진다.
 *   src/lib/env.ts 가 같은 이유로 이미 조심하고 있던 자리다.
 *
 *   자동 실행(/api/jobs/standards-sync)이 이 함수를 부르게 되면서 실제로 걸렸다.
 *   번들 환경에서는 프로세스의 작업 디렉터리(= 저장소 루트)를 기준으로 삼는다.
 */
function defaultDir(): string {
  const here = import.meta.dirname;
  // src/lib/standards/sync.ts → ../../../KC안전기준
  if (here) return join(here, '..', '..', '..', 'KC안전기준');
  return join(process.cwd(), 'KC안전기준');
}

export async function syncStandardsFolder(options: SyncOptions = {}): Promise<SyncFileResult[]> {
  const dir = options.dir ?? defaultDir();
  const db = getDb();

  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .filter((f) => (options.only ? f.includes(options.only) : true))
    .sort();

  const results: SyncFileResult[] = [];

  for (const file of files) {
    let displayName: string | null = null;
    try {
      const raw = readFileSync(join(dir, file), 'utf8');
      const parsed = parseStandardJson(file, raw);
      displayName = parsed.meta.display_name;

      const [current] = await db<{ id: number; source_sha256: string }[]>`
        select id, source_sha256 from public.standard
        where display_name = ${displayName} and is_current
        order by loaded_at desc
        limit 1
      `;

      if (current && current.source_sha256 === parsed.meta.source_sha256) {
        results.push({ file, displayName, status: 'unchanged', standardId: current.id });
        continue;
      }

      // 같은 내용을 다른 파일명으로 이미 넣어 둔 경우(재실행 등)는 그대로 둔다
      const [bySha] = await db<{ id: number }[]>`
        select id from public.standard where source_sha256 = ${parsed.meta.source_sha256}
      `;
      if (bySha && !current) {
        results.push({ file, displayName, status: 'unchanged', standardId: bySha.id });
        continue;
      }

      const inserted = await db.begin(async (tx) => {
        if (current) {
          // 개정 — 옛 판은 지우지 않고 내린다. 그 판에 달린 태깅·매칭·판단은 그대로 남는다.
          await tx`update public.standard set is_current = false where id = ${current.id}`;
        }
        return insertParsedStandard(tx, parsed);
      });

      results.push({
        file,
        displayName,
        status: current ? 'updated' : 'new',
        standardId: inserted.standardId,
        previousStandardId: current?.id,
        clauseCount: inserted.clauseCount,
        testMethodLinkCount: inserted.testMethodLinkCount,
      });
    } catch (e) {
      // 한 건이 실패해도 나머지는 진행한다 (§8.1 다건 처리 규칙과 같은 원칙)
      results.push({
        file,
        displayName,
        status: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}
