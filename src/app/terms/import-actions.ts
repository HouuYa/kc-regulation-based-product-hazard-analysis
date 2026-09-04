'use server';

import { revalidatePath } from 'next/cache';
import { previewTermsCsv, applyTermsCsv, type PreviewRow } from '@/lib/terms/csv';

/**
 * CSV 가져오기의 두 단계
 *
 * 미리보기와 적용을 나눈 이유는 TermImport.tsx 주석에 있다 — 사전이 조용히
 * 바뀌면 검색 결과도 조용히 바뀐다.
 */

export interface PreviewResult {
  rows: PreviewRow[];
}

export async function previewImport(csv: string): Promise<PreviewResult> {
  try {
    return { rows: await previewTermsCsv(csv) };
  } catch (e) {
    console.error('용어 사전 미리보기 실패:', e);
    return { rows: [] };
  }
}

export async function applyImport(csv: string): Promise<string> {
  try {
    const n = await applyTermsCsv(csv, null);
    revalidatePath('/terms');
    return n === 0 ? '바뀐 것이 없습니다.' : `${n}건을 반영했습니다.`;
  } catch (e) {
    console.error('용어 사전 가져오기 실패:', e);
    return `반영하지 못했습니다 — ${e instanceof Error ? e.message : e}`;
  }
}
