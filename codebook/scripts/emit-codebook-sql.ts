/**
 * 코드북 파싱 결과를 INSERT SQL 로 내보낸다.
 *
 *   npm run codebook:emit > .eval/codebook.sql
 *
 * 왜 필요한가
 *   v0.7 §0.4 는 코드북 업로드 전용 화면을 없애고 "관리자 스크립트·검증 리포트로
 *   충분"하다고 정리했다. 이 스크립트가 그 관리자 경로다.
 *   DB 접속 문자열 없이도 대시보드 SQL 편집기나 MCP 로 적재할 수 있고,
 *   무엇이 들어가는지 사람이 눈으로 검토한 뒤 실행할 수 있다.
 *
 * load-codebook.ts 와의 차이
 *   load-codebook 은 DATABASE_URL 로 직접 적재한다(배치용).
 *   이 스크립트는 SQL 텍스트만 만든다(검토·수동 적용용). 산출물은 같다.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parsePdr, versionFromFilename } from '../src/parse-pdr.js';
import { findCodebookFile } from './inspect-codebook.js';

/** SQL 리터럴. 코드북 정의문에 작은따옴표가 실제로 들어 있다 */
function lit(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${v.replace(/'/g, "''")}'`;
}

function textArray(values: string[]): string {
  if (values.length === 0) return `'{}'`;
  return `array[${values.map((v) => lit(v)).join(', ')}]::text[]`;
}

/** HF.H.ELEC.NPC → HF.H.ELEC / HF.H → null */
function parentOf(code: string): string | null {
  const seg = code.split('.');
  return seg.length <= 2 ? null : seg.slice(0, -1).join('.');
}

function main() {
  const path = findCodebookFile();
  const filename = path.split(/[\\/]/).pop()!;
  const raw = readFileSync(path, 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const version = versionFromFilename(filename) ?? 'v0.0.0';
  const parsed = parsePdr(raw);

  const out: string[] = [];
  out.push(`-- 코드북 적재 — ${filename} (${version})`);
  out.push(`-- HF ${parsed.hazard_factors.length} · DT ${parsed.damage_types.length} · 제약 ${parsed.constraints.length} · 키워드 ${parsed.keywords.length}`);
  out.push('');
  out.push('begin;');
  out.push('');

  out.push(`insert into codebook.version (version, effective_date, status, source_filename, source_sha256)
values (${lit(version)}, null, 'draft', ${lit(filename)}, ${lit(sha256)})
on conflict (version) do update
  set source_filename = excluded.source_filename,
      source_sha256   = excluded.source_sha256;`);
  out.push('');

  // 같은 버전을 다시 내보내도 안전하도록 코드 행을 먼저 비운다
  const vid = `(select id from codebook.version where version = ${lit(version)})`;
  for (const t of ['code_keyword', 'code_constraint', 'hazard_factor', 'damage_type']) {
    out.push(`delete from codebook.${t} where version_id = ${vid};`);
  }
  out.push('');

  const hfValues = parsed.hazard_factors.map((h) =>
    `  (${vid}, ${lit(h.code)}, ${lit(h.mshell_level1)}, ${lit(h.category_l2)}, ` +
    `${lit(h.category_l3)}, ${h.depth}, ${lit(parentOf(h.code))}, ${lit(h.name_ko)}, ` +
    `${lit(h.name_en)}, ${lit(h.definition)}, ${lit(h.mshell_link)}, ${lit(h.example)}, ` +
    `${lit(h.is_recall_common)}, ${lit(h.source_section)})`,
  );
  out.push(`insert into codebook.hazard_factor
  (version_id, code, mshell_level1, category_l2, category_l3, depth, parent_code,
   name_ko, name_en, definition, mshell_link, example, is_recall_common, source_section)
values
${hfValues.join(',\n')};`);
  out.push('');

  const dtValues = parsed.damage_types.map((d) =>
    `  (${vid}, ${lit(d.code)}, ${lit(d.dt_group)}, ${lit(d.name_ko)}, ${lit(d.name_en)}, ` +
    `${lit(d.definition)}, ${lit(d.severity_min)}, ${lit(d.severity_max)}, ` +
    `${lit(d.prism_risk_level)}, ${lit(d.eu_safetygate_type)}, ${lit(d.source_section)})`,
  );
  out.push(`insert into codebook.damage_type
  (version_id, code, dt_group, name_ko, name_en, definition,
   severity_min, severity_max, prism_risk_level, eu_safetygate_type, source_section)
values
${dtValues.join(',\n')};`);
  out.push('');

  const conValues = parsed.constraints.map((c) =>
    `  (${vid}, ${lit(c.subject_prefix)}, ${lit(c.rule_type)}, ` +
    `${textArray(c.requires_any_of)}, ${lit(c.reason)}, ${lit(c.source_section)})`,
  );
  out.push(`insert into codebook.code_constraint
  (version_id, subject_prefix, rule_type, requires_any_of, reason, source_section)
values
${conValues.join(',\n')};`);
  out.push('');

  // 존재하는 코드만 — 참조 무결성이 깨지면 태깅 프롬프트가 헛돈다
  const hfCodes = new Set(parsed.hazard_factors.map((h) => h.code));
  const dtCodes = new Set(parsed.damage_types.map((d) => d.code));
  const kwValues = parsed.keywords
    .filter((k) => (k.axis === 'HF' ? hfCodes.has(k.code) : dtCodes.has(k.code)))
    .map((k) =>
      `  (${vid}, ${lit(k.axis)}, ${lit(k.code)}, ${lit(k.keyword)}, ` +
      `${lit(k.keyword_group)}, ${lit(k.source_section)})`,
    );
  out.push(`insert into codebook.code_keyword
  (version_id, axis, code, keyword, keyword_group, source_section)
values
${kwValues.join(',\n')}
on conflict do nothing;`);
  out.push('');

  // 유효 버전은 하나뿐이다
  out.push(`update codebook.version set status = 'superseded' where status = 'active';`);
  out.push(`update codebook.version set status = 'active' where version = ${lit(version)};`);
  out.push('');
  out.push('commit;');

  process.stdout.write(out.join('\n') + '\n');
}

main();
