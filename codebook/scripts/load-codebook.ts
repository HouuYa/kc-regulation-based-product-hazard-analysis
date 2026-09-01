/**
 * 코드북 MD → DB 적재
 *
 *   npm run codebook:load                          새 버전을 draft 로 적재
 *   npm run codebook:load -- --activate            적재 후 현재 유효 버전으로 지정
 *   npm run codebook:load -- --version v0.9.7 --effective 2026-01-01
 *
 * 원칙 (설계문서 §8.2)
 *   확정 시 새 버전으로 등록한다. 기존 버전은 덮어쓰지 않는다.
 *   과거 태깅이 어떤 정의로 붙었는지 되짚을 수 있어야 하기 때문이다.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parsePdr, versionFromFilename } from '../src/parse-pdr';
import { findCodebookFile } from './inspect-codebook';
import { getDb, closeDb, insertMany } from '../../src/lib/db';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** HF.H.ELEC.NPC → HF.H.ELEC / HF.H → null */
function parentOf(code: string): string | null {
  const seg = code.split('.');
  return seg.length <= 2 ? null : seg.slice(0, -1).join('.');
}

async function main() {
  const path = findCodebookFile();
  const filename = path.split(/[\\/]/).pop()!;
  const raw = readFileSync(path, 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');

  const version = argValue('--version') ?? versionFromFilename(filename);
  if (!version) {
    throw new Error('버전을 알 수 없습니다. --version v0.9.7 처럼 지정해 주세요.');
  }
  const effective = argValue('--effective');
  const activate = process.argv.includes('--activate');

  const parsed = parsePdr(raw);
  if (parsed.failures.length) {
    console.warn(`파싱 실패 ${parsed.failures.length}건 — 적재에서 제외됩니다:`);
    for (const f of parsed.failures.slice(0, 10)) {
      console.warn(`  L${f.line_no} [${f.section}] ${f.reason}`);
    }
  }

  const db = getDb();

  // 같은 내용을 두 번 적재하지 않는다
  const dup = await db<{ id: number; version: string }[]>`
    select id, version from codebook.version where source_sha256 = ${sha256}
  `;
  if (dup.length > 0) {
    console.log(`이미 적재된 파일입니다 (버전 ${dup[0].version}). 적재를 건너뜁니다.`);
    if (activate) await activateVersion(dup[0].id, dup[0].version);
    return;
  }

  const [row] = await db<{ id: number }[]>`
    insert into codebook.version (version, effective_date, status, source_filename, source_sha256)
    values (
      ${version},
      ${effective},
      'draft',
      ${filename},
      ${sha256}
    )
    on conflict (version) do update
      set source_filename = excluded.source_filename,
          source_sha256   = excluded.source_sha256,
          effective_date  = coalesce(excluded.effective_date, codebook.version.effective_date)
    returning id
  `;
  const versionId = row.id;

  // 같은 버전을 다시 적재하는 경우를 위해 코드 행을 먼저 비운다.
  // 버전 자체는 유지되므로 이력이 사라지지 않는다.
  await db`delete from codebook.code_keyword    where version_id = ${versionId}`;
  await db`delete from codebook.code_constraint where version_id = ${versionId}`;
  await db`delete from codebook.hazard_factor   where version_id = ${versionId}`;
  await db`delete from codebook.damage_type     where version_id = ${versionId}`;

  const hfCols = [
    'version_id', 'code', 'mshell_level1', 'category_l2', 'category_l3', 'depth',
    'parent_code', 'name_ko', 'name_en', 'definition', 'mshell_link', 'example',
    'is_recall_common', 'source_section',
  ] as const;
  const hfRows = parsed.hazard_factors.map((h) => ({
    version_id: versionId,
    code: h.code,
    mshell_level1: h.mshell_level1,
    category_l2: h.category_l2,
    category_l3: h.category_l3,
    depth: h.depth,
    parent_code: parentOf(h.code),
    name_ko: h.name_ko,
    name_en: h.name_en,
    definition: h.definition,
    mshell_link: h.mshell_link,
    example: h.example,
    is_recall_common: h.is_recall_common,
    source_section: h.source_section,
  }));

  const dtCols = [
    'version_id', 'code', 'dt_group', 'name_ko', 'name_en', 'definition',
    'severity_min', 'severity_max', 'prism_risk_level', 'eu_safetygate_type', 'source_section',
  ] as const;
  const dtRows = parsed.damage_types.map((d) => ({
    version_id: versionId,
    code: d.code,
    dt_group: d.dt_group,
    name_ko: d.name_ko,
    name_en: d.name_en,
    definition: d.definition,
    severity_min: d.severity_min,
    severity_max: d.severity_max,
    prism_risk_level: d.prism_risk_level,
    eu_safetygate_type: d.eu_safetygate_type,
    source_section: d.source_section,
  }));

  const conCols = [
    'version_id', 'subject_prefix', 'rule_type', 'requires_any_of', 'reason', 'source_section',
  ] as const;
  const conRows = parsed.constraints.map((c) => ({
    version_id: versionId,
    subject_prefix: c.subject_prefix,
    rule_type: c.rule_type,
    requires_any_of: c.requires_any_of,
    reason: c.reason,
    source_section: c.source_section,
  }));

  // 키워드는 존재하는 코드만 넣는다 — 참조 무결성이 깨지면 태깅 프롬프트가 헛돈다
  const hfCodes = new Set(parsed.hazard_factors.map((h) => h.code));
  const dtCodes = new Set(parsed.damage_types.map((d) => d.code));
  const kwCols = ['version_id', 'axis', 'code', 'keyword', 'keyword_group', 'source_section'] as const;
  const kwRows = parsed.keywords
    .filter((k) => (k.axis === 'HF' ? hfCodes.has(k.code) : dtCodes.has(k.code)))
    .map((k) => ({
      version_id: versionId,
      axis: k.axis,
      code: k.code,
      keyword: k.keyword,
      keyword_group: k.keyword_group,
      source_section: k.source_section,
    }));

  await insertMany('codebook.hazard_factor', hfCols, hfRows);
  await insertMany('codebook.damage_type', dtCols, dtRows);
  await insertMany('codebook.code_constraint', conCols, conRows);
  await insertMany('codebook.code_keyword', kwCols, kwRows);

  console.log(`버전 ${version} 적재 완료 (id=${versionId})`);
  console.log(`  HF ${hfRows.length}건 / DT ${dtRows.length}건 / 제약 ${conRows.length}건 / 키워드 ${kwRows.length}건`);

  if (activate) await activateVersion(versionId, version);
  else console.log('  상태는 draft 입니다. 유효 버전으로 지정하려면 --activate 를 붙이세요.');
}

/** 유효 버전은 하나뿐이다. 기존 active 를 superseded 로 밀고 이 버전을 세운다. */
async function activateVersion(versionId: number, version: string) {
  const db = getDb();
  await db.begin(async (tx) => {
    await tx`update codebook.version set status = 'superseded' where status = 'active' and id <> ${versionId}`;
    await tx`update codebook.version set status = 'active' where id = ${versionId}`;
  });
  console.log(`  버전 ${version} 을 현재 유효 버전으로 지정했습니다.`);
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
