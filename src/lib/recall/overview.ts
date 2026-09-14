import { getDb } from '../db';

/**
 * 리콜 개요 — 사건 상세 화면에 「표 + 사진」으로 보여줄 만한 요약만 뽑는다
 * (2026-09-14, 담당자 지적: "사고보고서 원문 전체 보기가 텍스트 형태라 보기
 * 힘드네요. 리콜 개요를 보여주세요 — 표 형태로, 사진은 꼭 필요합니다")
 *
 * `recall_cache`는 원본 API 응답 전체를 `raw` jsonb 로 그대로 보관한다(§7.1
 * 원본층, 008 마이그레이션). 타입 컬럼으로 승격된 것은 title·brand·model·
 * hazard_type·hazard_summary(=hazard_description 한글) 뿐이고, 제품 설명·
 * 리콜 사유·소비자 조치·사진 URL(image_1~5)은 `raw` 안에만 있다 — 실물로
 * 확인했다(2026-09-14, US_CPSC·EU 표본): `image_1`~`image_5`가 실제 공개
 * Storage URL이고, 해외 리콜 2,376건 중 2,295건(96.6%)이 사진을 최소 1장
 * 갖고 있다. "_original" 이 안 붙은 raw 필드는 원본 파이프라인이 이미 한글로
 * 옮겨 둔 값이라 그대로 쓴다.
 *
 * 지금까지 실측된 것은 전부 origin='OVERSEAS' 다(국내 리콜은 아직 0건,
 * 2026-09-14 확인) — 필드가 다르게 오더라도 이 함수는 없는 값을 그냥
 * null/빈 배열로 돌려줄 뿐이라 깨지지 않는다.
 */
export interface RecallOverviewData {
  title: string | null;
  brand: string | null;
  model: string | null;
  recallCountry: string | null;
  countryOfOrigin: string | null;
  hazardType: string | null;
  /** = recall_cache.hazard_summary(위해 내용, 이미 한글) */
  hazardSummary: string | null;
  recallCause: string | null;
  productDescription: string | null;
  unitsAffected: string | null;
  consumerAction: string | null;
  publishedOn: string | null;
  detailUrl: string | null;
  /** 빈 문자열·null 을 걸러낸 것만 담는다 */
  images: string[];
}

interface RecallOverviewRow {
  title: string | null; brand: string | null; model: string | null;
  recall_country: string | null; hazard_type: string | null; hazard_summary: string | null;
  published_on: string | null; detail_url: string | null;
  country_of_origin: string | null; product_description: string | null;
  recall_cause: string | null; units_affected: string | null; consumer_action: string | null;
  image_1: string | null; image_2: string | null; image_3: string | null;
  image_4: string | null; image_5: string | null;
}

/** 이 사건(caseId)에 딸린 리콜 원본이 있으면 개요를 돌려준다. 없으면 null(사고보고서 등) */
export async function loadRecallOverview(caseId: number): Promise<RecallOverviewData | null> {
  const db = getDb();
  const [row] = await db<RecallOverviewRow[]>`
    select
      title, brand, model, recall_country, hazard_type, hazard_summary,
      published_on::text, detail_url,
      raw->>'country_of_origin' as country_of_origin,
      raw->>'product_description' as product_description,
      raw->>'recall_cause' as recall_cause,
      raw->>'units_affected' as units_affected,
      raw->>'consumer_action' as consumer_action,
      raw->>'image_1' as image_1, raw->>'image_2' as image_2, raw->>'image_3' as image_3,
      raw->>'image_4' as image_4, raw->>'image_5' as image_5
    from public.recall_cache
    where case_id = ${caseId}
    order by fetched_at desc
    limit 1
  `;
  if (!row) return null;

  const images = [row.image_1, row.image_2, row.image_3, row.image_4, row.image_5]
    .filter((u): u is string => !!u && u.trim().length > 0);

  return {
    title: row.title, brand: row.brand, model: row.model,
    recallCountry: row.recall_country, countryOfOrigin: row.country_of_origin,
    hazardType: row.hazard_type, hazardSummary: row.hazard_summary,
    recallCause: row.recall_cause, productDescription: row.product_description,
    unitsAffected: row.units_affected, consumerAction: row.consumer_action,
    publishedOn: row.published_on, detailUrl: row.detail_url,
    images,
  };
}
