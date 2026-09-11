/**
 * 사고사진 비전 분석 — 시간 예산 안에서 조금씩 돈다 (068)
 *
 * tag-run.ts와 같은 이유로 시간(개수가 아니라)으로 끊는다 — 보고서마다 사진
 * 수가 다르고 비전 호출 시간도 흔들리므로, 개수로 자르면 어떤 차례는 시간
 * 제한을 넘기고 어떤 차례는 너무 적게 처리한다.
 *
 * tag-chunk와 달리 3연속 실패 추적(029)은 두지 않는다 — 사고사진은 연 50건
 * 안팎으로 적어(catalog.ts), 실패가 쌓여도 068에서 추가한 ops_watch()의
 * "AI 호출 실패" 알림이 바로 잡아낸다. 두 겹으로 추적하면 어느 쪽이 실제
 * 카운트인지 헷갈리기만 한다.
 */

import { getDb } from '../db';
import { analyzeStoredPhotos } from './process-photos';

export interface PhotoVisionRunResult {
  processedFiles: number;
  analyzedPhotos: number;
  stoppedEarly: boolean;
  errors: string[];
}

interface PendingFile {
  source_file_id: number;
  item_name: string | null;
  title: string | null;
}

/** 아직 비전 분석하지 않은 사진이 딸린 사고보고서가 몇 건인가 — 화면이 남은 일을 보여 줄 때 쓴다 */
export async function countPendingPhotoVision(): Promise<number> {
  const db = getDb();
  const [row] = await db<{ n: number }[]>`
    select count(distinct source_file_id)::int as n
    from public.source_file_image
    where analyzed_at is null
  `;
  return row.n;
}

export async function runPhotoVisionChunk(
  opts: { timeBudgetMs: number; limit?: number },
): Promise<PhotoVisionRunResult> {
  const db = getDb();
  const started = Date.now();
  const limit = opts.limit ?? 20;

  // 보고서(source_file) 단위로 묶는다 — analyzePhotos()가 한 문서의 사진을
  // 한 번의 호출로 함께 보내 문맥(품목명·제목)을 공유하기 때문이다.
  const files = await db<PendingFile[]>`
    select distinct i.source_file_id, ce.item_name, ce.title
    from public.source_file_image i
    join public.case_event ce on ce.source_file_id = i.source_file_id
    where i.analyzed_at is null
    order by i.source_file_id
    limit ${limit}
  `;

  const result: PhotoVisionRunResult = {
    processedFiles: 0, analyzedPhotos: 0, stoppedEarly: false, errors: [],
  };

  for (const f of files) {
    // 시간 예산 확인은 한 보고서를 시작하기 전에만 한다 — 도중에 끊으면
    // 그 보고서 사진 일부만 분석된 채 남는다(tag-run.ts와 같은 원칙)
    if (Date.now() - started > opts.timeBudgetMs) {
      result.stoppedEarly = true;
      break;
    }
    try {
      const r = await analyzeStoredPhotos(db, f.source_file_id, { itemName: f.item_name, title: f.title });
      result.analyzedPhotos += r.analyzed;
      result.processedFiles += 1;
    } catch (e) {
      result.errors.push(`source_file ${f.source_file_id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return result;
}
