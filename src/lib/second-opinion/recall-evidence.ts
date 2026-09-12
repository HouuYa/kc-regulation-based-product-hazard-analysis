/**
 * 리콜 교차 근거 — 사고 원인 분석에 국내·해외 리콜을 함께 본다
 *
 * 성격이 다른 두 갈래를 둘 다 쓴다.
 *
 *   A 통계   "화재에는 보통 절연 불량이 따라온다" — 해외 리콜 2,299건에서 센 값
 *   B 사례   "같은 유리 본체 제품이 EU 에서 열충격으로 리콜됐다" — 낱건
 *
 *   A 만 있으면 추상적이고, B 만 있으면 표본이 1건이다. 담당자가 판단하려면 둘 다
 *   필요하다 — 통계는 방향을 주고, 사례는 그 방향이 이 제품에서 실제로 일어난
 *   적이 있음을 보인다.
 *
 * 왜 사고보고서는 통계의 재료가 아닌가
 *   cause-bridge.ts 가 ACCIDENT 를 계산에서 빼 둔 그대로 쓴다. 사고보고서는 77%가
 *   원인 미상이라 세면 분포가 아니라 결측을 세게 된다. 재료로는 못 쓰지만
 *   **쓰는 쪽**으로는 여기가 처음이다.
 *
 * 이 소견은 전부 REFERENCE 다
 *   시험항목도 확인항목도 아니다. "이런 자료가 있으니 참고하라" 까지가 몫이고,
 *   원인 후보를 고르는 것은 품목을 아는 담당자다 (04-1 §7).
 */

import { getDb } from '../db';
import { estimateCauses, type CauseCandidate } from '../codebook/cause-bridge';
import { crosswalk, type CrosswalkResult } from '../recall/crosswalk';

export type RecallMatchMode = 'VECTOR' | 'GPC' | 'BOTH' | 'NONE';

export interface SimilarRecall {
  caseId: number;
  title: string | null;
  itemName: string | null;
  sourceType: string;
  similarity: number;
  gpcMatchLevel: string;
  /** 그 리콜에 붙은 원인 코드 — 우리 사건에 없는 것을 채워 볼 재료 */
  hfCodes: string[];
  dtCodes: string[];
  recallCountry: string | null;
  detailUrl: string | null;
  hazardType: string | null;
  /** 그 리콜이 든 표준이 우리 KC 기준과 대조되는가 */
  crosswalk: CrosswalkResult | null;
}

export interface RecallEvidence {
  /** 갈래 A — 통계 다리 */
  statistical: CauseCandidate[];
  /** 갈래 B — 닮은 리콜 사례 */
  similar: SimilarRecall[];
  /** 몇 건을 견주어 고른 것인가. 화면이 이 말을 빠뜨리면 "해외와 비교했다"가 과장이 된다 */
  note: string;
}

/**
 * 닮은 리콜을 찾는다.
 *
 * case_event.embedding 은 채워져 있는데 지금까지 조회하는 코드가 한 줄도 없었다.
 * 070 의 similar_recall_cases() 가 그 첫 자리다.
 *
 * GPC 계층 필터를 A/B 로 둔 이유 — 임베딩이 품목이 닮은 것을 찾는지 사고 문체가
 * 닮은 것을 찾는지 재 본 적이 없다. GPC 만으로도 쓸 만하면 임베딩을 안 써도 된다.
 */
export async function findSimilarRecalls(
  caseId: number,
  mode: RecallMatchMode,
  limit = 8,
): Promise<SimilarRecall[]> {
  if (mode === 'NONE') return [];
  const db = getDb();

  const [ev] = await db<{
    embedding: string | null;
    seg: string | null; fam: string | null; cls: string | null; brick: string | null;
  }[]>`
    select embedding::text as embedding,
           gpc_verified_segment_code as seg, gpc_verified_family_code as fam,
           gpc_verified_class_code  as cls, gpc_verified_brick_code  as brick
    from public.case_event where id = ${caseId}
  `;
  // 임베딩이 없으면 닮은 것을 찾을 수 없다. GPC 만으로 찾는 경로는 두지 않았다 —
  // 같은 Segment("전기용품") 안에 수천 건이 있어 좁혀 주지 못한다
  if (!ev?.embedding) return [];

  const rows = await db<{
    case_id: string; similarity: string; gpc_match_level: string; source_type: string;
  }[]>`
    select * from public.similar_recall_cases(
      ${ev.embedding}::extensions.vector(1536),
      ${ev.seg}, ${ev.fam}, ${ev.cls}, ${ev.brick},
      ${limit},
      ${mode === 'GPC'}
    )
  `;
  if (rows.length === 0) return [];

  const ids = rows.map((r) => Number(r.case_id));

  const [meta, tags, cache] = await Promise.all([
    db<{ id: string; title: string | null; item_name: string | null }[]>`
      select id, title, item_name from public.case_event where id = any(${ids})
    `,
    db<{ case_id: string; axis: string; code: string }[]>`
      select case_id, axis, code from public.case_tag
      where case_id = any(${ids}) and review_status <> 'rejected' and code <> 'HF.UNKNOWN'
    `,
    db<{
      case_id: string; recall_country: string | null; detail_url: string | null;
      hazard_type: string | null; hazard_summary: string | null;
    }[]>`
      select case_id, recall_country, detail_url, hazard_type, hazard_summary
      from public.recall_cache where case_id = any(${ids})
    `,
  ]);

  const metaBy = new Map(meta.map((m) => [Number(m.id), m]));
  const cacheBy = new Map(cache.map((c) => [Number(c.case_id), c]));
  const tagBy = new Map<number, { hf: string[]; dt: string[] }>();
  for (const t of tags) {
    const id = Number(t.case_id);
    const e = tagBy.get(id) ?? { hf: [], dt: [] };
    (t.axis === 'HF' ? e.hf : e.dt).push(t.code);
    tagBy.set(id, e);
  }

  const out: SimilarRecall[] = [];
  for (const r of rows) {
    const id = Number(r.case_id);
    const c = cacheBy.get(id);
    out.push({
      caseId: id,
      title: metaBy.get(id)?.title ?? null,
      itemName: metaBy.get(id)?.item_name ?? null,
      sourceType: r.source_type,
      similarity: Number(r.similarity),
      gpcMatchLevel: r.gpc_match_level,
      hfCodes: tagBy.get(id)?.hf ?? [],
      dtCodes: tagBy.get(id)?.dt ?? [],
      recallCountry: c?.recall_country ?? null,
      detailUrl: c?.detail_url ?? null,
      hazardType: c?.hazard_type ?? null,
      // 공고에 위반 표준이 적힌 것은 27.9% 뿐이다. crosswalk() 가 그 사실을
      // note 에 담아 돌려주므로 화면이 분모를 말할 수 있다
      crosswalk: c?.hazard_summary ? await crosswalk(c.hazard_summary) : null,
    });
  }
  return out;
}

/**
 * 통계와 사례를 함께 모은다.
 *
 * 통계 쪽은 routes 를 넓게 받는다. cause-bridge.ts 의 기본값은 ['TEST'] 인데,
 * 그 파일 주석이 "거르기는 쓸 때 한다" 고 적어 둔 대로 여기서는 LEGAL·GAP 도
 * 받아 ②·④로 흘려보낸다.
 */
export async function collectRecallEvidence(
  caseId: number,
  dtCodes: string[],
  mode: RecallMatchMode,
  limit = 8,
): Promise<RecallEvidence> {
  const [statistical, similar] = await Promise.all([
    dtCodes.length > 0
      ? estimateCauses(dtCodes, { routes: ['TEST', 'LEGAL', 'GAP'], limit })
      : Promise.resolve([]),
    findSimilarRecalls(caseId, mode, limit),
  ]);

  const notes: string[] = [];
  if (statistical.length > 0) {
    const n = statistical[0].sampleSize;
    notes.push(`해외 리콜에서 같은 피해유형 ${n}건을 세어 원인 후보 ${statistical.length}개를 냈습니다`);
  } else if (dtCodes.length === 0) {
    notes.push('이 사건에 확정된 피해유형 코드가 없어 통계 다리를 쓸 수 없습니다');
  } else {
    notes.push('이 피해유형으로는 근거 5건 이상인 원인 후보가 없습니다');
  }
  notes.push(
    similar.length > 0
      ? `닮은 리콜 ${similar.length}건을 찾았습니다`
      : '닮은 리콜을 찾지 못했습니다',
  );

  return { statistical, similar, note: notes.join(' · ') };
}
