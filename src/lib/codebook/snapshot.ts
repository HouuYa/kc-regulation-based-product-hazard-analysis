/**
 * 코드북 스냅샷 로딩 (설계문서 §2.4.2)
 *
 * 왜 스냅샷을 한 번 받아 두는가
 *   "태깅 배치가 조항 수천 건을 돌 때 건별로 원격 조회를 하면 느리고 불안정하다."
 *   조항 하나를 태깅할 때마다 코드 목록이 필요한데, 그 목록은 배치 내내 바뀌지 않는다.
 *
 * v0.7 §5.5 의 보완
 *   0단계에서는 별도 서비스 대신 버전이 고정된 로컬 스냅샷을 쓴다.
 *   서로 다른 DB Project 사이에는 FK 를 두지 않고 codebook_version + code 로 논리 참조한다.
 *   지금은 같은 DB 의 codebook 스키마가 그 스냅샷 역할을 한다.
 */

import { getDb } from '../db.js';
import type { CodebookSnapshot, CodeOption } from '../llm/tagging.js';

interface CodeRow {
  axis: 'HF' | 'DT';
  code: string;
  name_ko: string;
  definition: string | null;
}

/**
 * 현재 유효 버전의 코드 목록을 가져온다.
 *
 * @param includeUncommon false 면 L0·L1 을 뺀다.
 *   PDR §0.4: 담당자가 실수로 L0·L1 만 단독 입력하는 오류를 막기 위해 기본 목록에서 제외한다.
 *   태깅 프롬프트도 같은 이유로 기본 제외가 안전하다 — 목록에 없으면 고를 수 없다.
 */
export async function loadCodebookSnapshot(
  options: { version?: string; includeUncommon?: boolean } = {},
): Promise<CodebookSnapshot> {
  const db = getDb();
  const includeUncommon = options.includeUncommon ?? false;

  const [ver] = await db<{ version: string }[]>`
    select v.version
    from codebook.version v
    where ${options.version ? db`v.version = ${options.version}` : db`v.status = 'active'`}
    limit 1
  `;
  if (!ver) {
    throw new Error(
      options.version
        ? `코드북 버전 ${options.version} 이 없습니다.`
        : '유효한 코드북 버전이 없습니다. npm run codebook:load -- --activate 를 먼저 실행하세요.',
    );
  }

  const rows = await db<CodeRow[]>`
    select axis, code, name_ko, definition
    from public.get_codes(${ver.version}, null, ${includeUncommon})
  `;

  // 키워드는 코드마다 몇 개만 있으면 충분하다. 전부 넣으면 프롬프트가 비대해진다.
  const kwRows = await db<{ code: string; keyword: string }[]>`
    select k.code, k.keyword
    from codebook.code_keyword k
    join codebook.version v on v.id = k.version_id
    where v.version = ${ver.version}
  `;
  const keywordsByCode = new Map<string, string[]>();
  for (const k of kwRows) {
    const list = keywordsByCode.get(k.code) ?? [];
    if (list.length < 8) list.push(k.keyword);
    keywordsByCode.set(k.code, list);
  }

  const toOption = (r: CodeRow): CodeOption => ({
    code: r.code,
    name_ko: r.name_ko,
    definition: r.definition,
    keywords: keywordsByCode.get(r.code),
  });

  return {
    version: ver.version,
    hf: rows.filter((r) => r.axis === 'HF').map(toOption),
    dt: rows.filter((r) => r.axis === 'DT').map(toOption),
  };
}

/**
 * 저장 직전 코드 검증 (§5.2.2 "스키마를 통과해도 한 번 더 검증")
 *
 * enum 을 통과했더라도 코드북에 없는 조합이면 거부한다.
 * 조합 제약(L0·L1 단독 금지)도 여기서 걸린다 — 규칙은 코드가 아니라 표에 있다.
 */
export async function validateCodes(
  hfCodes: string[],
  dtCodes: string[],
  version?: string,
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const db = getDb();
  const rows = await db<{ severity: string; subject: string; message: string }[]>`
    select severity, subject, message
    from public.validate_code_set(${hfCodes}::text[], ${dtCodes}::text[], ${version ?? null})
  `;
  const errors = rows.filter((r) => r.severity === 'ERROR').map((r) => `${r.subject}: ${r.message}`);
  const warnings = rows.filter((r) => r.severity !== 'ERROR').map((r) => `${r.subject}: ${r.message}`);
  return { ok: errors.length === 0, errors, warnings };
}

/** 코드 → 한글명. 검색용 텍스트의 분류명 머리말(변형 A)에 쓴다 */
export function codeLabelMap(snapshot: CodebookSnapshot): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of [...snapshot.hf, ...snapshot.dt]) m.set(o.code, o.name_ko);
  return m;
}
