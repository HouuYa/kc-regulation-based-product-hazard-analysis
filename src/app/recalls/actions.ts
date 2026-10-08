'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { DISTRIBUTION_LABEL } from './data';

/**
 * 해외 리콜 제품이 국내에도 풀렸는지 담당자가 기록한다 (05_02 P1-1, 2026-10-07)
 *
 * 흐름도는 이 일을 "사람이 할 일"로 그려 두었는데, 정작 값을 바꾸는 코드가 저장소
 * 어디에도 없었다 — 2,399건 전부 UNCHECKED 로 남은 이유다. 이 판단이 있어야 국내
 * 보고 의무를 따질 수 있으므로(013), 리콜 분석자 1단계의 핵심 입력이다.
 *
 * 재수집이 이 값을 덮지 않는다 — load.ts 의 upsert 갱신 열에 domestic_check 이 없다.
 */
export async function setDomesticCheck(_prev: string | null, formData: FormData): Promise<string> {
  const caseId = Number(formData.get('caseId'));
  const value = String(formData.get('value') ?? '');
  if (!caseId || !(value in DISTRIBUTION_LABEL)) return '알 수 없는 값입니다.';

  await getDb()`update public.recall_cache set domestic_check = ${value} where case_id = ${caseId}`;

  revalidatePath('/recalls');
  revalidatePath(`/analysis/${caseId}`);
  return `「${DISTRIBUTION_LABEL[value]}」로 기록했습니다.`;
}
