'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { extractPdf } from '@/lib/cases/extract-pdf';
import { putOriginal } from '@/lib/supabase/server';

/**
 * 화면 A — 사고보고서 다건 업로드 (설계문서 §8.1)
 *
 * 다건 처리 규칙
 *   파일별 독립 작업으로 처리한다. 한 건이 실패해도 나머지는 진행한다.
 *   파일 해시로 중복을 판별한다. 같은 파일을 다시 올리면 알려 주고 건너뛴다.
 *
 * 개인정보 (v0.7 §0.2)
 *   설계문서는 "개인정보를 제외한 PDF만 받는다"고 전제했지만 그 전제가 지켜졌는지
 *   확인하는 절차가 없었다. 여기서 추출 직후 검사하고, 걸리면 코드화(외부 LLM 호출)로
 *   넘기지 않는다. 파일은 보관하되 상태를 error 로 두어 담당자가 판단하게 한다.
 *
 * 확정 전에는 분석 대상이 아니다
 *   추출 결과를 담당자가 눈으로 확인하기 전까지 is_confirmed 는 false 다.
 *   L0 가 표를 뭉갰는지는 사람이 봐야 안다.
 */

export interface UploadReport {
  filename: string;
  status: 'ok' | 'duplicate' | 'scanned' | 'pii-blocked' | 'error';
  message: string;
  pageCount?: number;
  charCount?: number;
  caseId?: number;
}

export async function uploadAccidentPdfs(formData: FormData): Promise<void> {
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  const db = getDb();

  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      const [dup] = await db<{ id: number }[]>`
        select id from public.source_file
        where kind = 'ACCIDENT_PDF' and sha256 = ${sha256}
      `;
      if (dup) continue;

      const extracted = await extractPdf(bytes);

      // 원본은 불변층에 보관한다(§7.1). 버킷이 없으면 보관만 건너뛰고 진행한다 —
      // 추출 결과까지 버리면 담당자가 다시 올려야 하기 때문이다.
      let storagePath: string | null = null;
      try {
        storagePath = await putOriginal('accident', sha256, file.name, bytes, 'application/pdf');
      } catch (e) {
        console.warn(`원본 보관 실패 (${file.name}): ${e instanceof Error ? e.message : e}`);
        storagePath = null;
      }

      const blocked = extracted.piiFindings.length > 0;
      const status = blocked ? 'error' : extracted.looksScanned ? 'error' : 'extracted';
      const errorReason = blocked
        ? `개인정보로 보이는 값 발견: ${extracted.piiFindings.map((p) => `${p.kind} ${p.count}건`).join(', ')}`
        : extracted.looksScanned
          ? '텍스트 레이어가 없는 스캔본으로 보입니다. OCR 이 필요합니다.'
          : null;

      const [sf] = await db<{ id: number }[]>`
        insert into public.source_file
          (kind, filename, sha256, storage_path, byte_size, page_count,
           extracted_chars, extracted_text, status, error_reason)
        values ('ACCIDENT_PDF', ${file.name}, ${sha256}, ${storagePath}, ${bytes.byteLength},
                ${extracted.pageCount}, ${extracted.charCount},
                ${extracted.text.slice(0, 200000)}, ${status}, ${errorReason})
        returning id
      `;

      // 개인정보가 걸렸거나 스캔본이면 사건을 만들지 않는다.
      // 사건이 만들어지면 코드화 대상이 되고, 그러면 외부 LLM 으로 나간다.
      if (status === 'extracted') {
        await db`
          insert into public.case_event (source_file_id, source_type, title, narrative)
          values (${sf.id}, 'ACCIDENT', ${file.name.replace(/\.pdf$/i, '')},
                  ${extracted.text.slice(0, 20000)})
        `;
      }
    } catch {
      // 한 건이 실패해도 나머지는 진행한다 (§8.1)
      continue;
    }
  }

  revalidatePath('/accidents');
}

/**
 * 담당자 확정 — 이 시점부터 분석 대상이 된다 (§8.1)
 *
 * 결과를 문장으로 돌려준다 — 주소를 바꾸면 화면이 통째로 다시 그려져 깜빡이고,
 * 목록을 내려간 상태에서는 맨 위의 안내가 보이지도 않는다(ActionForm 주석 참고).
 */
export async function confirmCase(
  _prev: string | null,
  formData: FormData,
): Promise<string> {
  const caseId = Number(formData.get('caseId'));
  if (!caseId) return '사건을 찾지 못했습니다.';
  try {
    await getDb()`
      update public.case_event set is_confirmed = true, confirmed_at = now() where id = ${caseId}
    `;
  } catch (e) {
    console.error(`원문 확인 처리 실패 (사건 ${caseId}):`, e);
    return `처리에 실패했습니다 — ${e instanceof Error ? e.message : e}`;
  }
  revalidatePath('/accidents');
  return '확인했습니다. 이제 분석할 수 있습니다.';
}
