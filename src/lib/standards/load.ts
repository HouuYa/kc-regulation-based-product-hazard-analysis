/**
 * 파싱된 안전기준 1건을 DB 에 넣는 삽입 로직 (설계문서 §2.2)
 *
 * scripts/load-standards.ts(CLI 배치)와 src/lib/standards/sync.ts(폴더 감지 동기화,
 * 그리고 그 API 라우트)가 이 함수 하나를 공유한다. 두 경로가 각자 삽입문을 들고
 * 있으면 스키마가 바뀔 때 한쪽만 고치게 되고, 그 어긋남은 조용히 데이터를 망가뜨린다.
 *
 * 한 기준을 한 트랜잭션으로 넣는다. 중간에 실패하면 그 기준은 통째로 되돌아가므로
 * 조항은 들어갔는데 연결은 안 들어간 어중간한 상태가 생기지 않는다. 트랜잭션 경계는
 * 호출자가 정한다 — sync.ts 는 기존 판을 is_current=false 로 내리는 작업까지
 * 같은 트랜잭션에 묶어야 하기 때문이다.
 */

import type { TransactionSql } from 'postgres';
import type { ParsedStandard } from './types';

/**
 * 조각에 붙일 머리말 (§5.2.4 맥락 결합)
 *
 * "조항 하나를 떼어내면 어느 품목의 몇 장 몇 절인지가 사라진다. 4.3.3 안정성만
 *  남으면 유아용 의자인지 유모차인지 알 수 없다."
 *
 * 여기서는 절반만 만든다. 적재 시점에 알 수 있는 것은 품목과 계위뿐이고,
 * 코드북 분류명은 태깅이 끝나야 붙는다(§2.2 순서 주의).
 */
export function buildPreTagContextHeader(p: ParsedStandard, breadcrumbPath: string | null): string {
  const item = p.meta.item_name ?? p.meta.standard_no ?? p.meta.display_name;
  const scope = [p.meta.cert_scheme, p.meta.annex_no ? `부속서 ${p.meta.annex_no}` : null]
    .filter(Boolean)
    .join(' ');
  const lines = [`품목: ${item}${scope ? ` (${scope})` : ''}`];
  if (breadcrumbPath) lines.push(`위치: ${breadcrumbPath}`);
  return lines.join('\n');
}

export interface InsertStandardResult {
  standardId: number;
  clauseCount: number;
  testConditionCount: number;
  linkCount: number;
  testMethodLinkCount: number;
}

/**
 * standard → clause → test_condition/clause_link 순으로 한 기준을 넣는다.
 *
 * @param tx 트랜잭션 핸들. 호출자가 db.begin(...) 으로 열어 넘긴다.
 */
export async function insertParsedStandard(
  tx: TransactionSql,
  p: ParsedStandard,
): Promise<InsertStandardResult> {
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
    context_header: buildPreTagContextHeader(p, c.breadcrumb_path),
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

  return {
    standardId: std.id,
    clauseCount: p.clauses.length,
    testConditionCount: p.test_conditions.length,
    linkCount: p.links.length,
    testMethodLinkCount: p.links.filter((l) => l.link_type === 'TEST_METHOD').length,
  };
}
