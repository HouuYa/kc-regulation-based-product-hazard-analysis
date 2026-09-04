/**
 * 사고조사보고서 PDF → 일괄 적재 (설계문서 §4.2 L0, §8.1)
 *
 *   npm run cases:load                      사고조사보고서/ 전체
 *   npm run cases:load -- --only "가습기"
 *   npm run cases:load -- --force           같은 파일도 다시 처리
 *
 * 화면 A(웹 업로드, src/app/cases/actions.ts)와 같은 파이프라인을 로컬 폴더
 * 배치로 돌린다. 담당자가 파일을 하나씩 웹에서 올릴 필요 없이, 폴더에 쌓인
 * 사고조사보고서를 한 번에 처리한다.
 *
 * 개인정보 (v0.7 §0.2)
 *   파일명이 이미 "비식별화"를 표시하고 있지만, 그 표시만 믿지 않는다.
 *   추출 직후 PII 탐지를 그대로 통과시키고, 걸리면 사건을 만들지 않는다 —
 *   사건이 만들어지면 코드화(L2) 대상이 되어 외부 LLM 으로 나가기 때문이다.
 *   원문은 source_file 에 남기고 상태만 error 로 두어, 담당자가 판단할 여지를 둔다.
 *
 * 확정 전에는 분석 대상이 아니다
 *   이 스크립트는 추출까지만 한다. is_confirmed 는 화면 A 에서 담당자가 원문을
 *   눈으로 확인한 뒤에만 true 가 된다 — L0 가 표를 뭉갰는지는 사람이 봐야 안다.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getDb, closeDb } from '../src/lib/db';
import { extractPdf, extractPhotos, type ExtractedPhoto } from '../src/lib/cases/extract-pdf';
import { putOriginal } from '../src/lib/supabase/server';
import { analyzePhotos } from '../src/lib/llm/vision';
import { findAndVerifyGpc, DEFAULT_GPC_CANDIDATE_COUNT } from '../src/lib/gpc/assign';
import { extractItemName } from '../src/lib/cases/item-name';

const CASES_DIR = join(import.meta.dirname, '..', '사고조사보고서');

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/**
 * 첨부 사진을 추출·보관·분석하고, 증거 사진에서 뽑은 제품 서술로 GPC 코드까지
 * 조회한다(2026-09-02). 실패해도 사건 적재 자체는 막지 않는다 — 텍스트만으로도
 * 이미 유효한 사건이고, 사진 분석은 보강 정보다.
 */
async function processPhotos(
  db: ReturnType<typeof getDb>,
  sourceFileId: number,
  bytes: Buffer,
  itemName: string | null,
  title: string,
): Promise<string> {
  const photos = await extractPhotos(new Uint8Array(bytes));
  if (photos.length === 0) return '';

  const stored: Array<ExtractedPhoto & { storagePath: string | null }> = [];
  for (const p of photos) {
    const photoHash = createHash('sha256').update(p.jpeg).digest('hex');
    let storagePath: string | null = null;
    try {
      storagePath = await putOriginal('accident-photo', photoHash, `p${p.pageNumber}.jpg`, p.jpeg, 'image/jpeg');
    } catch (e) {
      console.warn(`  경고: 사진 보관 실패 (p${p.pageNumber}): ${e instanceof Error ? e.message : e}`);
    }
    stored.push({ ...p, storagePath });
  }

  let vision: Awaited<ReturnType<typeof analyzePhotos>> | null = null;
  try {
    vision = await analyzePhotos(photos, { itemName, title });
  } catch (e) {
    console.warn(`  경고: 사진 분석 실패: ${e instanceof Error ? e.message : e}`);
  }

  const byPage = new Map(vision?.photos.map((p) => [p.pageNumber, p]) ?? []);
  for (const p of stored) {
    if (!p.storagePath) continue;
    const a = byPage.get(p.pageNumber);
    await db`
      insert into public.source_file_image
        (source_file_id, page_number, storage_path, width, height, byte_size,
         is_relevant_photo, description, hazard_note, vision_model, analyzed_at)
      values (
        ${sourceFileId}, ${p.pageNumber}, ${p.storagePath}, ${p.width}, ${p.height}, ${p.jpeg.byteLength},
        ${a?.isRelevantPhoto ?? null}, ${a?.description ?? null}, ${a?.hazardNote ?? null},
        ${vision?.model ?? null}, ${vision ? new Date().toISOString() : null}
      )
      on conflict (source_file_id, page_number, storage_path) do nothing
    `;
  }

  let gpcNote = '';
  if (vision?.productDescription) {
    try {
      // 조회+검증은 standard(scripts/tag-standards-gpc.ts)와 findAndVerifyGpc() 를
      // 공유한다(라운드 12) — 예전엔 후보 5개 중 1위를 검증 없이 확정했는데, 이제는
      // KC기준 쪽과 같은 Brick→Class→Family→Segment 단계적 검증을 거친다.
      const context = [
        `품목명: ${itemName ?? title}`,
        `사고 제목: ${title}`,
        `제품 설명(사고사진 분석): ${vision.productDescription}`,
      ].join('\n');
      const { candidates, verification } = await findAndVerifyGpc(
        itemName ?? title,
        context,
        DEFAULT_GPC_CANDIDATE_COUNT,
      );
      const top = candidates[0] ?? null;

      await db`
        update public.case_event
        set gpc_brick_code            = ${top?.brickCode ?? null},
            gpc_candidates            = ${db.json(candidates as never)},
            gpc_verified_level        = ${verification.level},
            gpc_verified_segment_code  = ${verification.segmentCode},
            gpc_verified_segment_title = ${verification.segmentTitle},
            gpc_verified_family_code  = ${verification.familyCode},
            gpc_verified_family_title  = ${verification.familyTitle},
            gpc_verified_class_code   = ${verification.classCode},
            gpc_verified_class_title   = ${verification.classTitle},
            gpc_verified_brick_code   = ${verification.brickCode},
            gpc_verified_brick_title   = ${verification.brickTitle},
            gpc_verification          = ${db.json(verification as never)}
        where source_file_id = ${sourceFileId}
      `;

      gpcNote =
        verification.level === 'NONE'
          ? ` · GPC 후보 ${candidates.length}개, 검증 결과 NONE(맞는 후보 없음)`
          : ` · GPC 후보 ${candidates.length}개, 검증 ${verification.level} ${
              { BRICK: verification.brickCode, CLASS: verification.classCode, FAMILY: verification.familyCode, SEGMENT: verification.segmentCode }[
                verification.level
              ]
            }(${
              { BRICK: verification.brickTitle, CLASS: verification.classTitle, FAMILY: verification.familyTitle, SEGMENT: verification.segmentTitle }[
                verification.level
              ]
            }) 확신 ${verification.confidenceScore}`;
    } catch (e) {
      console.warn(`  경고: GPC 조회 실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  const relevant = vision?.photos.filter((p) => p.isRelevantPhoto).length ?? 0;
  return `\n           사진 ${photos.length}장 추출 · 증거사진 판정 ${relevant}장${gpcNote}`;
}

async function loadOne(filename: string, force: boolean): Promise<string> {
  const db = getDb();
  const bytes = readFileSync(join(CASES_DIR, filename));
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const [dup] = await db<{ id: number }[]>`
    select id from public.source_file where kind = 'ACCIDENT_PDF' and sha256 = ${sha256}
  `;
  if (dup && !force) {
    return `건너뜀   ${filename} (이미 적재됨)`;
  }

  const extracted = await extractPdf(new Uint8Array(bytes));

  /*
    원본은 불변층에 보관한다(§7.1). 보관에 실패하면 여기서 멈춘다.

    전에는 보관만 건너뛰고 진행했다 — "추출 결과까지 버리면 담당자가 다시 올려야
    하기 때문"이었다. 그런데 그렇게 하면 사건이 만들어지고 분석까지 이어지는데
    원본 PDF 는 어디에도 없다. 사고보고서는 개인정보 때문에 저장소에 두지 않으므로
    Storage 가 유일한 보관처다. 즉 조항 결과에서 원문 페이지로 되짚을 길이 영영
    사라진다 — 이 체계가 지키기로 한 것이 바로 그 되짚기다(02 설계서 §3.3).

    화면 업로드(src/app/accidents/actions.ts)는 이미 이렇게 고쳤는데 이 스크립트는
    옛 동작 그대로였다. 같은 일을 하는 두 입구가 다르게 굴면, 어느 쪽으로 들어온
    자료인지에 따라 보관 여부가 달라진다(CLAUDE.md §9).

    추출 결과는 버리지 않는다. status='error' 로 남기므로 담당자가 무엇이 왜
    막혔는지 볼 수 있고, 버킷을 고친 뒤 --force 로 다시 돌리면 된다.
  */
  let storagePath: string | null = null;
  let storageError: string | null = null;
  try {
    storagePath = await putOriginal('accident', sha256, filename, bytes, 'application/pdf');
  } catch (e) {
    // 원인은 반드시 남긴다 — 예전에 이 자리가 완전히 침묵해서
    // "Invalid key"(한글 파일명) 버그를 한참 찾아야 했다.
    storageError = e instanceof Error ? e.message : String(e);
    console.error(`  원본 보관 실패 (${filename}): ${storageError}`);
  }

  const blocked = extracted.piiFindings.length > 0;
  const status = storageError || blocked || extracted.looksScanned ? 'error' : 'extracted';
  const errorReason = storageError
    ? `원본 보관에 실패해 분석 대상으로 넘기지 않았습니다: ${storageError}`
    : blocked
      ? `개인정보로 보이는 값 발견: ${extracted.piiFindings.map((p) => `${p.kind} ${p.count}건`).join(', ')}`
      : extracted.looksScanned
        ? '텍스트 레이어가 없는 스캔본으로 보입니다. OCR 이 필요합니다.'
        : null;

  if (dup && force) {
    // 원본·사건을 함께 다시 만든다. case_event 는 source_file_id 참조라 cascade 되지 않으므로 직접 정리한다.
    await db`delete from public.case_event where source_file_id = ${dup.id}`;
    await db`delete from public.source_file where id = ${dup.id}`;
  }

  const [sf] = await db<{ id: number }[]>`
    insert into public.source_file
      (kind, filename, sha256, storage_path, byte_size, page_count,
       extracted_chars, extracted_text, status, error_reason)
    values ('ACCIDENT_PDF', ${filename}, ${sha256}, ${storagePath}, ${bytes.byteLength},
            ${extracted.pageCount}, ${extracted.charCount},
            ${extracted.text.slice(0, 200000)}, ${status}, ${errorReason})
    returning id
  `;

  let photoNote = '';
  if (status === 'extracted') {
    const title = filename.replace(/\.pdf$/i, '');
    await db`
      insert into public.case_event (source_file_id, source_type, title, narrative)
      values (${sf.id}, 'ACCIDENT', ${title}, ${extracted.text.slice(0, 20000)})
    `;

    try {
      photoNote = await processPhotos(db, sf.id, bytes, extractItemName(extracted.text), title);
    } catch (e) {
      console.warn(`  경고: 사진 처리 실패 (${filename}): ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    `${status === 'extracted' ? '적재 완료' : '보류    '} ${filename}\n` +
    `           ${extracted.pageCount}쪽 · 추출 ${extracted.charCount.toLocaleString()}자` +
    (errorReason ? `\n           ${errorReason}` : '') +
    photoNote
  );
}

async function main() {
  const only = argValue('--only');
  const force = process.argv.includes('--force');

  const files = readdirSync(CASES_DIR)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .filter((f) => (only ? f.includes(only) : true))
    .sort();

  if (files.length === 0) {
    throw new Error(only ? `"${only}" 를 포함하는 PDF 가 없습니다.` : '사고조사보고서/ 에 PDF 가 없습니다.');
  }

  console.log(`${files.length}건 처리 시작\n`);
  let ok = 0;
  let blocked = 0;
  const failures: string[] = [];

  for (const f of files) {
    try {
      const msg = await loadOne(f, force);
      console.log(msg);
      if (msg.startsWith('보류')) blocked++;
      else ok++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`실패     ${f}: ${message}`);
      failures.push(f);
    }
  }

  console.log('');
  console.log(`완료 ${ok} · 보류(개인정보·스캔본) ${blocked} · 실패 ${failures.length} / 전체 ${files.length}건`);
  console.log('확정 전에는 분석 대상이 아닙니다. /cases 화면에서 원문을 확인하고 확정하세요.');
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
