/**
 * 해외 리콜 적재 — 트랙 B 의 입구
 *
 *   npm run recalls:fetch -- --q 가습기          검색어로
 *   npm run recalls:fetch -- --source EU --limit 50
 *   npm run recalls:fetch -- --stats             출처별 현황만
 *
 * 두 가지를 한 번에 한다.
 *   1) recall_cache 에 원본을 그대로 보관한다(§7.1 원본층). 협회가 원본을 관리하므로
 *      우리는 실제로 인용한 건만 사본으로 철해 둔다(0.2 방안 A).
 *   2) case_event 에 source_type='RECALL_OVERSEAS' 로 승격한다.
 *
 * 2)를 하는 이유. 004 스키마가 이미 그 자리를 비워 두었다 —
 *   source_type check (... 'RECALL_DOMESTIC', 'RECALL_OVERSEAS')
 * 리콜을 사건 행으로 두면 태깅·임베딩·검색·검수·평가가 전부 그대로 돌아간다.
 * 다만 v0.6 코멘트가 지적했듯 그것만으로는 트랙 B 가 아니다. 제품 동일성·외국
 * 기준 근거·조치 검토는 별도 모듈(recalls:analyze)이 맡는다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { fetchRecalls, fetchStats, type HubRecall } from '../src/lib/recall/hub';
import { crosswalk } from '../src/lib/recall/crosswalk';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** 검색·태깅이 읽을 서술문을 만든다. 제품명과 위해 서술을 붙인다 */
function narrativeOf(r: HubRecall): string {
  return [
    r.product_name,
    r.product_name_original && r.product_name_original !== r.product_name
      ? `(${r.product_name_original})` : null,
    r.brand_name || null,
    r.model_name ? `모델 ${r.model_name}` : null,
    r.hazard_type,
    r.hazard_description,
  ].filter(Boolean).join(' · ');
}

async function main() {
  if (process.argv.includes('--stats')) {
    const s = await fetchStats();
    console.log(`해외 리콜 전체 ${s.total_recalls.toLocaleString()}건`);
    for (const b of s.by_source) {
      console.log(`  ${b.source.padEnd(16)}${String(b.count).padStart(5)}건   최신 ${b.latest_date}`);
    }
    return;
  }

  const q = argValue('--q') ?? undefined;
  const source = argValue('--source') ?? undefined;
  const limit = argValue('--limit') ? Number(argValue('--limit')) : undefined;

  if (!q && !source && !limit) {
    throw new Error('조건을 지정하세요:  --q 가습기  |  --source EU  |  --limit 100  |  --stats');
  }

  console.log(`Recall Hub 조회 : ${[q && `검색어 "${q}"`, source && `출처 ${source}`, limit && `최대 ${limit}건`].filter(Boolean).join(' · ')}`);
  const rows = await fetchRecalls({ q, source, limit });
  console.log(`받은 건수       : ${rows.length}`);
  if (rows.length === 0) return;

  const db = getDb();
  let cached = 0, promoted = 0, withStd = 0;

  for (const r of rows) {
    const cw = await crosswalk(r.hazard_description);
    if (cw.standardIds.length) withStd++;

    // 원본층 — 받은 것을 그대로 둔다. 필드가 늘어도 다시 받아 오지 않는다
    const [cache] = await db<{ id: number }[]>`
      insert into public.recall_cache (
        source, guid, origin, title, brand, model, hazard_summary,
        hazard_type, recall_country, published_on, detail_url,
        cited_standards, matched_standard_ids, raw, fetched_at
      ) values (
        ${r.source}, ${r.guid}, 'OVERSEAS',
        ${r.product_name}, ${r.brand_name}, ${r.model_name}, ${r.hazard_description},
        ${r.hazard_type}, ${r.recall_country}, ${r.published_date}, ${r.source_url},
        ${cw.cited.map((c) => c.raw)}, ${cw.standardIds},
        ${db.json(r as never)}, now()
      )
      on conflict (source, guid) do update set
        title = excluded.title, hazard_summary = excluded.hazard_summary,
        hazard_type = excluded.hazard_type,
        cited_standards = excluded.cited_standards,
        matched_standard_ids = excluded.matched_standard_ids,
        raw = excluded.raw, fetched_at = now()
      returning id
    `;
    cached++;

    // 사건 행으로 승격 — 트랙 A 와 같은 엔진을 타기 위한 통로
    const externalRef = `${r.source}:${r.guid}`;
    const [ev] = await db<{ id: number }[]>`
      insert into public.case_event (
        source_type, external_ref, title, narrative, item_name, model_name,
        occurred_on, raw_fields, is_confirmed
      ) values (
        'RECALL_OVERSEAS', ${externalRef}, ${r.product_name},
        ${narrativeOf(r)}, ${r.product_name}, ${r.model_name},
        ${r.published_date}, ${db.json({ source: r.source, country: r.recall_country,
          hazard_type: r.hazard_type, source_url: r.source_url,
          cited_standards: cw.cited.map((c) => c.raw), crosswalk_note: cw.note } as never)},
        false
      )
      on conflict do nothing
      returning id
    `;
    if (ev) {
      promoted++;
      await db`update public.recall_cache set case_id = ${ev.id} where id = ${cache.id}`;
    }
  }

  console.log('');
  console.log(`캐시 저장       : ${cached}건`);
  console.log(`사건 행 생성    : ${promoted}건 (source_type=RECALL_OVERSEAS, 미확정)`);
  console.log(`KC 기준 대조    : ${withStd}건 — 공고에 명시된 위반 표준이 우리 기준과 번호가 같은 경우`);
  console.log('');
  console.log('다음 : npm run recalls:code   위해요인 코드를 붙입니다 (Recall Hub 는 코드를 주지 않습니다)');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
