/**
 * 안전기준 파싱 JSON → DB 적재
 *
 *   npm run standards:load                          KC안전기준/ 전체
 *   npm run standards:load -- --only "부속서 8"       파일명에 포함된 것만
 *   npm run standards:load -- --only "공통안전기준"
 *   npm run standards:load -- --force               이미 적재된 것도 다시 넣는다
 *
 * 한 기준을 한 트랜잭션으로 넣는다. 중간에 실패하면 그 기준은 통째로 되돌아가므로
 * 조항은 들어갔는데 연결은 안 들어간 어중간한 상태가 생기지 않는다.
 *
 * context_header 는 여기서 절반만 만든다 (§5.2.4).
 *   적재 시점에 알 수 있는 것은 품목과 계위뿐이다. 코드북 분류명은 태깅이 끝나야
 *   붙으므로, 태깅 배치가 이 값을 이어 쓴다. 그래서 search_text 조립도 태깅 뒤다(§2.2).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, closeDb, insertMany } from '../src/lib/db.js';
import { parseStandardJson } from '../src/lib/standards/parse-result-json.js';
import type { ParsedStandard } from '../src/lib/standards/types.js';
import { listStandardFiles, STANDARDS_DIR } from './inspect-standards.js';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/**
 * 조각에 붙일 머리말 (§5.2.4 맥락 결합)
 *
 * "조항 하나를 떼어내면 어느 품목의 몇 장 몇 절인지가 사라진다. 4.3.3 안정성만
 *  남으면 유아용 의자인지 유모차인지 알 수 없다."
 */
function buildContextHeader(p: ParsedStandard, breadcrumbPath: string | null): string {
  const item = p.meta.item_name ?? p.meta.standard_no ?? p.meta.display_name;
  const scope = [p.meta.cert_scheme, p.meta.annex_no ? `부속서 ${p.meta.annex_no}` : null]
    .filter(Boolean)
    .join(' ');
  const lines = [`품목: ${item}${scope ? ` (${scope})` : ''}`];
  if (breadcrumbPath) lines.push(`위치: ${breadcrumbPath}`);
  return lines.join('\n');
}

async function loadOne(file: string, force: boolean): Promise<string> {
  const raw = readFileSync(join(STANDARDS_DIR, file), 'utf8');
  const p = parseStandardJson(file, raw);
  const db = getDb();

  const existing = await db<{ id: number }[]>`
    select id from public.standard where source_sha256 = ${p.meta.source_sha256}
  `;
  if (existing.length > 0 && !force) {
    return `건너뜀   ${p.meta.display_name} (이미 적재됨)`;
  }

  await db.begin(async (tx) => {
    if (existing.length > 0) {
      // --force: 조항·연결·시험조건은 cascade 로 함께 지워진다
      await tx`delete from public.standard where id = ${existing[0].id}`;
    }

    const [std] = await tx<{ id: number }[]>`
      insert into public.standard (
        source_filename, source_sha256, cert_scheme, annex_no, item_name,
        standard_no, display_name, total_pages, parser_model, ocr_confidence
      ) values (
        ${p.meta.source_filename}, ${p.meta.source_sha256}, ${p.meta.cert_scheme},
        ${p.meta.annex_no}, ${p.meta.item_name}, ${p.meta.standard_no},
        ${p.meta.display_name}, ${p.meta.total_pages}, ${p.meta.parser_model},
        ${p.meta.ocr_confidence}
      )
      returning id
    `;

    // 조항 — id 를 돌려받아야 연결과 시험조건을 붙일 수 있다
    const clauseRows = p.clauses.map((c) => ({
      standard_id: std.id,
      marker: c.marker,
      part: c.part,
      breadcrumb_path: c.breadcrumb_path,
      level_code: c.level_code,
      level_name: c.level_name,
      clause_type: c.clause_type,
      title_raw: c.title_raw,
      body: c.body,
      page_no: c.page_no,
      parse_confidence: c.parse_confidence,
      order_index: c.order_index,
      context_header: buildContextHeader(p, c.breadcrumb_path),
    }));

    const inserted = await tx<{ id: number; marker: string; part: string | null }[]>`
      insert into public.clause ${tx(
        clauseRows as never,
        'standard_id', 'marker', 'part', 'breadcrumb_path', 'level_code', 'level_name',
        'clause_type', 'title_raw', 'body', 'page_no', 'parse_confidence',
        'order_index', 'context_header',
      )}
      returning id, marker, part
    `;

    const idByKey = new Map<string, number>();
    const idByMarker = new Map<string, number>();
    for (const r of inserted) {
      idByKey.set(`${r.part ?? ''}|${r.marker}`, r.id);
      if (!idByMarker.has(r.marker)) idByMarker.set(r.marker, r.id);
    }

    // 시험조건
    const tcRows = p.test_conditions
      .map((t) => {
        const clauseId = idByKey.get(`${t.part ?? ''}|${t.clause_marker}`);
        if (!clauseId) return null;
        return {
          clause_id: clauseId,
          item_group: t.item_group,
          item_name: t.item_name,
          allowance_raw: t.allowance_raw,
          value_num: t.value_num,
          unit: t.unit,
          test_method_marker: t.test_method_marker,
          source: t.source,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (tcRows.length) {
      await tx`insert into public.test_condition ${tx(
        tcRows as never,
        'clause_id', 'item_group', 'item_name', 'allowance_raw',
        'value_num', 'unit', 'test_method_marker', 'source',
      )}`;
    }

    // 조항 연결. 미해결 참조는 to_clause_id 를 비워 둔 채 남긴다 —
    // 다른 기준(제1부)을 가리키는 참조가 실제로 많고, 버리면 나중에 이을 수 없다
    const seen = new Set<string>();
    const linkRows = p.links
      .map((l) => {
        const fromId = idByKey.get(`${l.from_part ?? ''}|${l.from_marker}`);
        if (!fromId) return null;
        const key = `${fromId}|${l.to_marker}|${l.link_source}`;
        if (seen.has(key)) return null;
        seen.add(key);
        const toId =
          idByKey.get(`${l.from_part ?? ''}|${l.to_marker}`) ??
          idByMarker.get(l.to_marker) ??
          null;
        return {
          from_clause_id: fromId,
          to_clause_id: toId,
          to_marker: l.to_marker,
          link_type: l.link_type,
          link_source: l.link_source,
          evidence_span: l.evidence_span,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (linkRows.length) {
      await tx`insert into public.clause_link ${tx(
        linkRows as never,
        'from_clause_id', 'to_clause_id', 'to_marker',
        'link_type', 'link_source', 'evidence_span',
      )}`;
    }
  });

  const testLinks = p.links.filter((l) => l.link_type === 'TEST_METHOD').length;
  return (
    `적재 완료 ${p.meta.display_name}\n` +
    `           조항 ${p.clauses.length} · 시험조건 ${p.test_conditions.length} · ` +
    `연결 ${p.links.length}(시험방법 ${testLinks})`
  );
}

async function main() {
  const only = argValue('--only');
  const force = process.argv.includes('--force');

  const files = listStandardFiles().filter((f) => (only ? f.includes(only) : true));
  if (files.length === 0) {
    throw new Error(only ? `"${only}" 를 포함하는 파일이 없습니다.` : 'KC안전기준/ 에 JSON 이 없습니다.');
  }

  console.log(`${files.length}개 기준 적재 시작\n`);
  let ok = 0;
  const failures: string[] = [];

  for (const f of files) {
    try {
      console.log(await loadOne(f, force));
      ok++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 한 건이 실패해도 나머지는 진행한다 (§8.1 다건 처리 규칙과 같은 원칙)
      console.error(`실패     ${f}: ${msg}`);
      failures.push(f);
    }
  }

  console.log('');
  console.log(`완료 ${ok}/${files.length}건`);
  if (failures.length) {
    console.log('실패 목록:');
    for (const f of failures) console.log('  -', f);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
