/**
 * GS1 GPC 적재 — 최신 판을 우리 쪽에 들이고 한국어를 붙인다
 *
 *   npm run gpc:load                    2026-05 판을 내려받아 적재
 *   npm run gpc:load -- --version 2025-11
 *   npm run gpc:load -- --no-embed      임베딩 없이 표만 채운다
 *   npm run gpc:load -- --dry           내려받아 세어만 본다
 *
 * 어디서 받는가 (실측 2026-09-04)
 *   https://ref.gs1.org/standards/gpc/{판}/ 이 인증 없이 zip 을 준다.
 *   안에 EN.json 이 있고 { LanguageCode, DateUtc, Schema[] } 구조로,
 *   Schema 는 Level/Code/Title/Definition/DefinitionExcludes/Active/Childs 가
 *   4계위(세그먼트→패밀리→클래스→브릭)로 중첩돼 있다.
 *
 * 한국어는 어디서 오는가
 *   GS1 정본은 영어뿐이다. 협회 색인(oecd_gpc_202405)에 한국어 제목이 있으므로
 *   브릭 코드를 공통 키로 조인해 붙인다. 협회 판은 2024-05 라 최신 브릭에는
 *   한국어가 없을 수 있다 — 없으면 비워 두고 몇 건인지 보고한다. 지어내지 않는다.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { getDb, closeDb, toVectorLiteral } from '../src/lib/db';
import { embedBatch } from '../src/lib/llm/client';
import { gpcConfig, openaiConfig } from '../src/lib/env';

const CACHE = join(import.meta.dirname, '..', '.gpc-cache');

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

interface Node {
  Level: number;
  Code: number;
  Title: string;
  Definition: string | null;
  DefinitionExcludes: string | null;
  Active: boolean;
  Childs?: Node[];
}

interface Brick {
  brick_code: string; brick_title_en: string;
  definition_en: string | null; excludes_en: string | null;
  class_code: string; class_title_en: string;
  family_code: string; family_title_en: string;
  segment_code: string; segment_title_en: string;
  active: boolean;
}

/** zip 안의 한 파일만 푼다. 라이브러리를 새로 들이지 않는다 */
function unzip(buf: Buffer, endsWith: string): Buffer {
  let p = 0;
  while (p < buf.length - 4) {
    if (buf.readUInt32LE(p) !== 0x04034b50) { p++; continue; }
    const method = buf.readUInt16LE(p + 8);
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const fname = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen + extraLen;
    if (fname.endsWith(endsWith)) {
      const data = buf.subarray(start, start + compSize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    p = start + compSize;
  }
  throw new Error(`zip 안에 ${endsWith} 로 끝나는 파일이 없습니다`);
}

async function fetchGpc(version: string): Promise<Node[]> {
  mkdirSync(CACHE, { recursive: true });
  const zipPath = join(CACHE, `gpc-${version}.zip`);

  if (!existsSync(zipPath)) {
    const url = `https://ref.gs1.org/standards/gpc/${version}/`;
    console.log(`내려받는 중: ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`GS1 응답 ${res.status} — 판 이름을 확인하세요(예: 2026-05)`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(zipPath, buf);
    console.log(`  ${(buf.length / 1024 / 1024).toFixed(1)} MB 저장`);
  } else {
    console.log(`이미 받아 둔 파일을 씁니다: ${zipPath}`);
  }

  const json = unzip(readFileSync(zipPath), 'EN.json');
  const doc = JSON.parse(json.toString('utf8')) as { LanguageCode: string; DateUtc: string; Schema: Node[] };
  console.log(`  판 ${version} · 언어 ${doc.LanguageCode} · 발행 ${doc.DateUtc}`);
  return doc.Schema;
}

/** 4계위 중첩을 브릭 한 줄로 편다 */
function flatten(segments: Node[]): Brick[] {
  const out: Brick[] = [];
  for (const seg of segments) {
    for (const fam of seg.Childs ?? []) {
      for (const cls of fam.Childs ?? []) {
        for (const brick of cls.Childs ?? []) {
          out.push({
            brick_code: String(brick.Code),
            brick_title_en: brick.Title,
            definition_en: brick.Definition,
            excludes_en: brick.DefinitionExcludes,
            class_code: String(cls.Code), class_title_en: cls.Title,
            family_code: String(fam.Code), family_title_en: fam.Title,
            segment_code: String(seg.Code), segment_title_en: seg.Title,
            active: brick.Active,
          });
        }
      }
    }
  }
  return out;
}

/** 협회 색인에서 한국어 제목을 브릭 코드로 가져온다 */
async function fetchKorean(): Promise<Map<string, { brick: string; cls: string; family: string; segment: string }>> {
  const { dbUrl, anonKey } = gpcConfig();
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const out = new Map<string, { brick: string; cls: string; family: string; segment: string }>();

  // PostgREST 는 한 번에 1000행이 상한이라 나눠 받는다
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${dbUrl}/rest/v1/oecd_gpc_202405?select=content&limit=1000&offset=${from}`, { headers });
    if (!res.ok) throw new Error(`협회 GPC 색인 조회 실패: ${res.status}`);
    const rows = await res.json() as Array<{ content: string }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      try {
        const j = JSON.parse(r.content) as Record<string, string>;
        if (j.brick_code) {
          out.set(String(j.brick_code), {
            brick: j.brick_title, cls: j.class_title,
            family: j.family_title, segment: j.segment_title,
          });
        }
      } catch { /* 한 줄이 깨져도 나머지는 쓴다 */ }
    }
    if (rows.length < 1000) break;
  }
  return out;
}

/**
 * 뜻으로 찾을 때 쓸 문장.
 *
 * 한국어를 앞에 둔다 — 우리 사고보고서가 한국어라 그쪽이 먼저 걸려야 한다.
 * 정의문을 넣는 것이 이 작업의 요점이다. 브릭 제목만으로는
 * "개인용 온열/마사지용품 (동력)" 처럼 여러 물건이 뭉뚱그려진다.
 */
function buildSearchText(b: Brick, ko?: { brick: string; cls: string; family: string; segment: string }): string {
  return [
    ko?.brick ? `품목: ${ko.brick}` : null,
    `Brick: ${b.brick_title_en}`,
    ko ? `분류: ${ko.segment} > ${ko.family} > ${ko.cls}` : `Class: ${b.segment_title_en} > ${b.family_title_en} > ${b.class_title_en}`,
    b.definition_en ? `정의: ${b.definition_en}` : null,
    b.excludes_en ? `제외: ${b.excludes_en}` : null,
  ].filter(Boolean).join('\n');
}

async function main() {
  const version = argValue('--version') ?? '2026-05';
  const dry = process.argv.includes('--dry');
  const noEmbed = process.argv.includes('--no-embed');

  const bricks = flatten(await fetchGpc(version));
  console.log(`\n브릭 ${bricks.length}건 (활성 ${bricks.filter((b) => b.active).length})`);

  console.log('협회 색인에서 한국어 제목을 가져오는 중…');
  const ko = await fetchKorean();
  const withKo = bricks.filter((b) => ko.has(b.brick_code)).length;
  console.log(`  한국어가 붙는 브릭 ${withKo} / ${bricks.length} (${Math.round(withKo / bricks.length * 100)}%)`);
  console.log(`  붙지 않는 ${bricks.length - withKo}건은 2024-05 이후에 생긴 브릭이거나 번역이 없는 것입니다.`);

  if (dry) { console.log('\n--dry — 저장하지 않았습니다.'); await closeDb(); return; }

  const db = getDb();
  const rows = bricks.map((b) => {
    const k = ko.get(b.brick_code);
    return {
      ...b,
      brick_title_ko: k?.brick ?? null,
      class_title_ko: k?.cls ?? null,
      family_title_ko: k?.family ?? null,
      segment_title_ko: k?.segment ?? null,
      gpc_version: version,
      search_text: buildSearchText(b, k),
    };
  });

  const COLS = [
    'brick_code', 'brick_title_en', 'brick_title_ko', 'definition_en', 'excludes_en',
    'class_code', 'class_title_en', 'class_title_ko',
    'family_code', 'family_title_en', 'family_title_ko',
    'segment_code', 'segment_title_en', 'segment_title_ko',
    'active', 'gpc_version', 'search_text',
  ] as const;

  console.log('\n적재 중…');
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db`
      insert into public.gpc_brick ${db(chunk as never, ...COLS)}
      on conflict (brick_code) do update set
        brick_title_en = excluded.brick_title_en, brick_title_ko = excluded.brick_title_ko,
        definition_en = excluded.definition_en, excludes_en = excluded.excludes_en,
        class_code = excluded.class_code, class_title_en = excluded.class_title_en,
        class_title_ko = excluded.class_title_ko,
        family_code = excluded.family_code, family_title_en = excluded.family_title_en,
        family_title_ko = excluded.family_title_ko,
        segment_code = excluded.segment_code, segment_title_en = excluded.segment_title_en,
        segment_title_ko = excluded.segment_title_ko,
        active = excluded.active, gpc_version = excluded.gpc_version,
        -- 검색용 문장이 바뀌면 임베딩은 무효다. 다시 만들어야 한다(§3.4)
        search_text = excluded.search_text,
        embedding = case when public.gpc_brick.search_text is distinct from excluded.search_text
                         then null else public.gpc_brick.embedding end,
        embedding_model = case when public.gpc_brick.search_text is distinct from excluded.search_text
                               then null else public.gpc_brick.embedding_model end,
        updated_at = now()
    `;
    process.stdout.write(`\r  ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }
  console.log('');

  if (noEmbed) {
    console.log('--no-embed — 임베딩은 만들지 않았습니다.');
    await closeDb();
    return;
  }

  const cfg = openaiConfig();
  const todo = await db<{ brick_code: string; search_text: string }[]>`
    select brick_code, search_text from public.gpc_brick
    where embedding is null and search_text is not null
  `;
  console.log(`\n임베딩 만들 것 ${todo.length}건`);
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    const vecs = await embedBatch(chunk.map((c) => c.search_text));
    for (let j = 0; j < chunk.length; j++) {
      await db`
        update public.gpc_brick
        set embedding = ${toVectorLiteral(vecs[j])}::extensions.vector(1536),
            embedding_model = ${cfg.embeddingModel}
        where brick_code = ${chunk[j].brick_code}
      `;
    }
    process.stdout.write(`\r  ${Math.min(i + 100, todo.length)}/${todo.length}`);
  }
  console.log('\n완료');
  await closeDb();
}

main().catch((e) => { console.error('실패:', e instanceof Error ? e.message : e); process.exitCode = 1; });
