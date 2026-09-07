/**
 * 해외 리콜 원본 표 직접 접근 (Recall Hub 관리자 시스템의 Supabase, 별도 프로젝트)
 *
 * hub.ts(얇은 REST API, 16개 필드)를 대체한다 — 2026-09-02 결정.
 *
 * 실물 확인 2026-09-02 (project xicivtmjfkpuehgsieex, 표 recalls)
 *   전체 4,828건 중 approved 2,252 / rejected 2,565 / pending 11.
 *   approved 건은 hazard_factor_code · damage_type_primary · iso5665_severity 가
 *   결측 없이 채워져 있다 — 담당자가 검토·분류까지 마친 값이므로 우리가 다시
 *   AI 로 태깅할 필요가 없다(§ 014 마이그레이션 주석).
 *
 *   korea_relevance 는 approved 건 전부 true 였다(hub.ts 시절과 같은 결과 —
 *   변별력은 없지만 조건에는 명시해 둔다).
 *
 * 화면의 「관리 대상」이 korea_relevance 다 (2026-09-07 확인)
 *   Recall Hub 관리자 화면(docs/해외리콜수집/recall-hub-admin화면.png)에는 「승인」과
 *   「관리 대상」이 **서로 다른 칸**으로 있다. 승인은 승인/반려 배지이고, 관리 대상은
 *   켜고 끄는 토글이다. 코드에서는 각각 approval_status 와 korea_relevance 인데,
 *   이름만 봐서는 「관리 대상」인 줄 알 수 없어 "그 조건이 걸려 있느냐"는 물음이
 *   반복됐다. 그래서 실물로 세어 근거를 남긴다.
 *
 *     승인   · 관리대상 O  2,336건   ← 우리가 받아 오는 것
 *     승인   · 관리대상 X      0건
 *     반려   · 관리대상 O      4건   ← 두 칸이 따로 움직인다는 증거
 *     반려   · 관리대상 X  2,634건
 *     대기   · 관리대상 X      5건
 *
 *   「승인이면서 관리대상 아님」은 0건이라 지금은 두 조건이 겹쳐 보이지만, 반려인데
 *   관리대상이 켜진 것이 4건 있다. 관리대상만으로 거르면 그 4건이 섞여 들어오므로
 *   **두 조건을 AND 로 함께 건다.**
 *
 * 서버 전용. sb_secret_* 키는 RLS 를 우회하므로 브라우저로 절대 노출하면 안 된다
 * (파일명이 source.ts 인 것과 NEXT_PUBLIC_ 접두사가 없는 것이 방어선 — server.ts 와 동일).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { required } from '../env';

/** recalls 표가 실제로 주는 필드 중, 우리가 컬럼으로 승격해 쓰는 것만 타입으로 적는다.
 *  나머지(원문 원본, 이미지, PDF, update_history 등)는 raw 로 통째로 보관한다 */
export interface SourceRecall {
  id: number;
  source: string;
  guid: string;
  product_name: string | null;
  product_name_original: string | null;
  brand_name: string | null;
  model_name: string | null;
  product_description: string | null;
  hazard_description: string | null;
  hazard_type: string | null;
  recall_cause: string | null;
  recall_country: string | null;
  source_url: string | null;
  published_date: string | null;
  korea_relevance: boolean | null;

  hazard_factor_code: string | null;
  hazard_factor_sub: string[] | null;
  damage_type_primary: string | null;
  damage_type_codes: string[] | null;
  iso5665_severity: number | null;

  approval_status: string | null;
  classification_confidence: number | null;
  injuries_count: number | null;
  has_confirmed_injuries: boolean | null;

  [key: string]: unknown;
}

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  client = createClient(
    required('RECALL_SOURCE_SUPABASE_URL'),
    required('RECALL_SOURCE_SUPABASE_SECRET_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return client;
}

/** PostgREST 가 한 번에 주는 최대치(기본 상한) */
const PAGE = 1000;

export interface FetchOptions {
  /** 출처 코드 (EU, US_CPSC, CN …) */
  source?: string;
  /** 최대 몇 건까지 받을 것인가 */
  limit?: number;
  /** 정렬된 승인 목록에서 건너뛸 건수 */
  offset?: number;
}

/**
 * 화면의 「승인」이면서 「관리 대상」인 건만 페이지를 넘겨 가며 모은다.
 * (approval_status='approved' AND korea_relevance=true — 위 주석의 실측 참고)
 */
export async function fetchApprovedRecalls(opts: FetchOptions = {}): Promise<SourceRecall[]> {
  const sb = getClient();
  const cap = opts.limit ?? Number.MAX_SAFE_INTEGER;
  const start = opts.offset ?? 0;
  const out: SourceRecall[] = [];

  for (let from = start; out.length < cap; from += PAGE) {
    const take = Math.min(PAGE, cap - out.length);
    let q = sb
      .from('recalls')
      .select('*')
      .eq('approval_status', 'approved')
      .eq('korea_relevance', true)
      .order('id', { ascending: true })
      .range(from, from + take - 1);
    if (opts.source) q = q.eq('source', opts.source);

    const { data, error } = await q;
    if (error) throw new Error(`recalls 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as SourceRecall[]));
    if (data.length < take) break;
  }
  return out;
}

/** 출처별 승인 건수. --stats 표시용 */
export async function fetchApprovedStats(): Promise<Array<{ source: string; count: number }>> {
  const rows = await fetchApprovedRecalls();
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}
