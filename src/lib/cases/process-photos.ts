/**
 * 사고보고서 PDF 첨부 사진 — 저장과 비전 분석을 분리한다 (068)
 *
 * 왜 나누나
 *   사진 추출·Storage 저장은 LLM 호출이 없어 빠르다(수백 ms~수 초). 반면
 *   비전 분석(analyzePhotos)은 사진이 많은 보고서(15장 넘는 것도 있다)에서
 *   수십 초가 걸릴 수 있다. 웹 업로드(src/app/accidents/actions.ts)는 배포
 *   환경의 요청 시간 제한(~30초 — 2026-09-11 리콜 수집 504로 실측 확인) 안에서
 *   끝나야 하므로, 이 둘을 한 요청에 몰아넣으면 리콜 수집과 같은 종류의
 *   타임아웃이 사진 많은 보고서에서 재현된다.
 *
 *   그래서 저장(storeExtractedPhotos)은 업로드 요청 안에서 동기로 하고,
 *   분석(analyzeStoredPhotos)은 job-tag-chunk와 같은 방식으로 배치 작업이
 *   나중에 시간 예산 안에서 돌게 한다(process-photos-run.ts).
 *
 * 전에는 scripts/load-cases.ts 안에 이 로직이 통째로 있었다. 웹 업로드도
 * 같은 처리가 필요해지면서(068) 두 곳에 각자 적으면 스키마가 바뀔 때 한쪽만
 * 고치게 된다(CLAUDE.md §9) — 그래서 여기 하나로 뽑고 두 진입점이 가져다 쓴다.
 */

import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { extractPhotos } from './extract-pdf';
import { putOriginal, getOriginal } from '../supabase/server';
import { analyzePhotos } from '../llm/vision';
import { findAndVerifyGpc, DEFAULT_GPC_CANDIDATE_COUNT } from '../gpc/assign';

type Db = ReturnType<typeof getDb>;

export interface StorePhotosResult {
  extracted: number;
  stored: number;
}

/**
 * PDF에서 사진을 뽑아 Storage에 저장하고 빈 행을 만든다. LLM 호출 없음 —
 * 웹 업로드 요청 안에서 동기로 불러도 안전하다.
 */
export async function storeExtractedPhotos(
  db: Db,
  sourceFileId: number,
  bytes: Uint8Array,
): Promise<StorePhotosResult> {
  const photos = await extractPhotos(bytes);
  let stored = 0;

  for (const p of photos) {
    const photoHash = createHash('sha256').update(p.jpeg).digest('hex');
    let storagePath: string | null = null;
    try {
      storagePath = await putOriginal('accident-photo', photoHash, `p${p.pageNumber}.jpg`, p.jpeg, 'image/jpeg');
    } catch (e) {
      console.warn(`사진 보관 실패 (p${p.pageNumber}): ${e instanceof Error ? e.message : e}`);
      continue;
    }
    await db`
      insert into public.source_file_image
        (source_file_id, page_number, storage_path, width, height, byte_size)
      values (${sourceFileId}, ${p.pageNumber}, ${storagePath}, ${p.width}, ${p.height}, ${p.jpeg.byteLength})
      on conflict (source_file_id, page_number, storage_path) do nothing
    `;
    stored++;
  }

  return { extracted: photos.length, stored };
}

interface PendingRow {
  id: number;
  page_number: number;
  storage_path: string;
  width: number;
  height: number;
}

export interface AnalyzePhotosResult {
  analyzed: number;
  gpcApplied: boolean;
}

/**
 * 아직 분석하지 않은 사진(analyzed_at is null)을 모아 비전 LLM으로 분석하고,
 * 증거 사진에서 뽑은 제품 서술로 GPC 코드까지 조회한다.
 *
 * 사진 bytes 는 다시 뽑지 않는다 — storeExtractedPhotos 가 이미 Storage 에
 * 올려 둔 JPEG 을 그대로 내려받는다.
 */
export async function analyzeStoredPhotos(
  db: Db,
  sourceFileId: number,
  context: { itemName: string | null; title: string | null },
): Promise<AnalyzePhotosResult> {
  const pending = await db<PendingRow[]>`
    select id, page_number, storage_path, width, height
    from public.source_file_image
    where source_file_id = ${sourceFileId} and analyzed_at is null
    order by page_number
  `;
  if (pending.length === 0) return { analyzed: 0, gpcApplied: false };

  const photos = await Promise.all(
    pending.map(async (row) => ({
      pageNumber: row.page_number,
      jpeg: await getOriginal(row.storage_path),
      width: row.width,
      height: row.height,
    })),
  );

  const vision = await analyzePhotos(photos, context);

  const byPage = new Map(vision.photos.map((p) => [p.pageNumber, p]));
  for (const row of pending) {
    const a = byPage.get(row.page_number);
    await db`
      update public.source_file_image
      set is_relevant_photo = ${a?.isRelevantPhoto ?? null},
          description        = ${a?.description ?? null},
          hazard_note        = ${a?.hazardNote ?? null},
          vision_model       = ${vision.model},
          analyzed_at        = now()
      where id = ${row.id}
    `;
  }

  let gpcApplied = false;
  if (vision.productDescription) {
    try {
      // 조회+검증은 standard(scripts/tag-standards-gpc.ts)와 findAndVerifyGpc()를
      // 공유한다(라운드 12) — KC기준 쪽과 같은 Brick→Class→Family→Segment 단계적
      // 검증을 거친다.
      const gpcContext = [
        `품목명: ${context.itemName ?? context.title ?? ''}`,
        `사고 제목: ${context.title ?? ''}`,
        `제품 설명(사고사진 분석): ${vision.productDescription}`,
      ].join('\n');
      const { candidates, verification } = await findAndVerifyGpc(
        context.itemName ?? context.title ?? '',
        gpcContext,
        DEFAULT_GPC_CANDIDATE_COUNT,
      );
      const top = candidates[0] ?? null;

      await db`
        update public.case_event
        set gpc_brick_code             = ${top?.brickCode ?? null},
            gpc_candidates             = ${db.json(candidates as never)},
            gpc_verified_level         = ${verification.level},
            gpc_verified_segment_code  = ${verification.segmentCode},
            gpc_verified_segment_title = ${verification.segmentTitle},
            gpc_verified_family_code   = ${verification.familyCode},
            gpc_verified_family_title  = ${verification.familyTitle},
            gpc_verified_class_code    = ${verification.classCode},
            gpc_verified_class_title   = ${verification.classTitle},
            gpc_verified_brick_code    = ${verification.brickCode},
            gpc_verified_brick_title   = ${verification.brickTitle},
            gpc_verification           = ${db.json(verification as never)}
        where source_file_id = ${sourceFileId}
      `;
      gpcApplied = true;
    } catch (e) {
      console.warn(`GPC 조회 실패 (source_file ${sourceFileId}): ${e instanceof Error ? e.message : e}`);
    }
  }

  return { analyzed: pending.length, gpcApplied };
}
