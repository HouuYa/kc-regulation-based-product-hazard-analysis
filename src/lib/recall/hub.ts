/**
 * Recall Hub 클라이언트 (해외 리콜 — 트랙 B 의 입력)
 *
 * 실물 확인 2026-09-01
 *   GET /api/v1/recalls?limit&offset&q&source   목록·검색 (q 는 한국어로 동작한다)
 *   GET /api/v1/stats                            출처별 건수
 *   인증  Authorization: Bearer rh_live_*
 *   봉투  { data: [...], meta: { total, limit, offset, has_more } }
 *
 * 주의 — 설계 때의 전제와 다른 점
 *   1) 응답에 hazard_factor_code / damage_type_codes 가 없다. 위해요인 코드는
 *      우리가 붙인다(013 마이그레이션 주석 참조).
 *   2) hazard_type 필터는 파라미터로 보내도 무시된다. 걸러지지 않은 결과가 그대로
 *      돌아오므로 서버 필터로 믿으면 안 된다. 코드로 거른다.
 *   3) korea_relevance 는 2,239건 전부 true 였다. 변별력이 없으므로 조건에 쓰지 않는다.
 */

import { recallConfig } from '../env';

/** /api/v1/recalls 가 실제로 주는 필드. 추측하지 않고 응답에서 그대로 옮겼다 */
export interface HubRecall {
  id: number;
  source: string;
  guid: string;
  product_name: string | null;
  product_name_original: string | null;
  brand_name: string | null;
  model_name: string | null;
  hazard_type: string | null;
  risk_level: string | null;
  published_date: string | null;
  image_1: string | null;
  korea_relevance: boolean | null;
  recall_country: string | null;
  source_url: string | null;
  hazard_description: string | null;
  classification_confidence: number | null;
}

interface Envelope {
  data: HubRecall[];
  meta: { total: number; limit: number; offset: number; has_more: boolean };
}

/** 서버가 한 번에 주는 최대치. 100 을 넘겨도 100 까지만 온다 */
const PAGE = 100;

async function get(path: string): Promise<Envelope> {
  const cfg = recallConfig();
  if (!cfg.hub.apiKey) {
    throw new Error('RECALL_HUB_API_KEY 가 비어 있습니다. .env.local 을 확인하세요.');
  }
  const res = await fetch(`${cfg.hub.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${cfg.hub.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Recall Hub ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as Envelope;
}

export interface FetchOptions {
  /** 검색어. 한국어로 동작한다 ("가습기" → 스팀식 가습기 리콜) */
  q?: string;
  /** 출처 코드 (EU, US_CPSC, CN …) */
  source?: string;
  /** 최대 몇 건까지 받을 것인가. 전수는 2,239건 */
  limit?: number;
}

/** 조건에 맞는 리콜을 페이지를 넘겨 가며 모은다 */
export async function fetchRecalls(opts: FetchOptions = {}): Promise<HubRecall[]> {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.source) params.set('source', opts.source);

  const cap = opts.limit ?? Number.MAX_SAFE_INTEGER;
  const out: HubRecall[] = [];

  for (let offset = 0; out.length < cap; offset += PAGE) {
    params.set('limit', String(Math.min(PAGE, cap - out.length)));
    params.set('offset', String(offset));
    const env = await get(`/api/v1/recalls?${params}`);
    if (env.data.length === 0) break;
    out.push(...env.data);
    if (!env.meta.has_more) break;
  }
  return out;
}

export async function fetchStats(): Promise<{
  total_recalls: number;
  by_source: Array<{ source: string; count: number; latest_date: string }>;
}> {
  const cfg = recallConfig();
  const res = await fetch(`${cfg.hub.baseUrl}/api/v1/stats`, {
    headers: { Authorization: `Bearer ${cfg.hub.apiKey}` },
  });
  if (!res.ok) throw new Error(`Recall Hub /stats → ${res.status}`);
  return res.json();
}
