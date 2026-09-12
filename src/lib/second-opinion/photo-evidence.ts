/**
 * 사진에서 건진 측정값·부품 구성을 병행 점검 재료로 끌어온다 (라운드 72)
 *
 * 왜 vision.ts 를 여기서 다시 부르지 않는가
 *   사진 분석(비용이 드는 LLM 호출)은 이미 `source_file_image`에 저장돼 있다.
 *   이 파일은 그 결과를 읽기만 한다 — 분석은 process-photos.ts/scripts/reanalyze-photos.ts
 *   가 미리(또는 배치로) 해 둔다.
 *
 * variant='B' 인 것만 읽는다
 *   variant A 는 측정값·부품구성 필드 자체가 비어 있다(질문을 안 했으니 답이 없다).
 *   variant 를 걸러 읽지 않으면 "재료가 없어서 0건"과 "아직 B로 안 돌려서 0건"을
 *   구분할 수 없다.
 *
 * 왜 손상(hazard_note)이 아니라 측정값·부품구성만 가져오는가
 *   라운드 68~69 가 hazard_note 를 tag-cases.ts 의 원인 코드화에 얹는 실험을
 *   이미 했고, 대조군에서 효과가 없었다(사진을 빼도 같은 코드가 나왔다). 그
 *   경로는 그대로 둔다 — 다시 건드리지 않는다. 여기서 새로 쓰는 것은 그 실험이
 *   손대지 않았던 다른 자리(병행 점검의 문턱값 공백·인증 신호 판단)다.
 */

import { getDb } from '../db';

export interface PhotoMeasurementItem {
  pageNumber: number;
  label: string;
  value: string;
  unit: string;
}

export interface PhotoEvidence {
  measurements: PhotoMeasurementItem[];
  components: string[];
  /** 측정값이나 부품구성이 실제로 하나라도 나왔는가 */
  used: boolean;
  /**
   * variant B 로 분석된 사진이 있었는가 (재료가 비어도 true 일 수 있다).
   *
   * "재료가 없어서 0건"과 "아직 B로 재분석하지 않아서 0건"을 갈라야 한다 —
   * 안 그러면 second_opinion_run.vision_prompt_variant 만 보고는 사진이
   * 아예 없었는지 재분석만 안 했는지 알 수 없다.
   */
  analyzedWithB: boolean;
}

const EMPTY: PhotoEvidence = { measurements: [], components: [], used: false, analyzedWithB: false };

export async function loadPhotoEvidence(caseId: number): Promise<PhotoEvidence> {
  const db = getDb();

  const rows = await db<{
    page_number: number; measurements: PhotoMeasurementItem[] | null; components: string[] | null;
  }[]>`
    select i.page_number, i.measurements, i.components
    from public.source_file_image i
    join public.case_event e on e.source_file_id = i.source_file_id
    where e.id = ${caseId}
      and i.is_relevant_photo
      and i.vision_prompt_variant = 'B'
  `;
  if (rows.length === 0) return EMPTY;

  const measurements: PhotoMeasurementItem[] = [];
  const components = new Set<string>();
  for (const r of rows) {
    for (const m of r.measurements ?? []) {
      measurements.push({ pageNumber: r.page_number, label: m.label, value: m.value, unit: m.unit });
    }
    for (const c of r.components ?? []) components.add(c);
  }

  return {
    measurements,
    components: [...components],
    used: measurements.length > 0 || components.size > 0,
    analyzedWithB: true,
  };
}
