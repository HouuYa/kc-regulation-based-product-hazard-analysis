/**
 * 품목분류 판정 이력 — 대상을 가리지 않고 한 표에 쌓는다 (064)
 *
 * 왜 한 표인가
 *   같은 판정인데 기록이 셋으로 갈려 있었다 — 기준은 standard.gpc_candidates,
 *   사건은 case_event.gpc_candidates, 품목은 scope_term_gpc. 그래서 「AI 가
 *   품목분류를 어떻게 붙이고 있나」를 한 번에 볼 수가 없었고, 새 호출부를 붙일
 *   때마다 저장 코드를 다시 썼다.
 *
 * 각 대상 표의 칸과 무엇이 다른가
 *   대상 표의 칸은 **지금의 답**이고 사람이 검수해 확정하는 자리다.
 *   이 표는 **그 답이 어떻게 나왔는가**의 이력이다. 답은 덮어써도 이력은 쌓인다.
 *   같은 품목을 다시 돌리면 여기에 줄이 하나 더 생기고, 두 판정이 왜 달라졌는지
 *   질의문과 후보를 나란히 놓고 볼 수 있다.
 */

import { getDb } from '../db';
import type { GpcCandidate } from './lookup';
import type { GpcVerification } from './verify';
import type { ProductImageDescription } from './describe-image';

export interface GpcSubject {
  /** TERM=품목 용어, STANDARD=안전기준, CASE=사고·리콜, ADHOC=API 로 한 번 물어본 것 */
  type: 'TERM' | 'STANDARD' | 'CASE' | 'ADHOC';
  /** TERM 은 term_key, STANDARD·CASE 는 id. ADHOC 은 제품명 등 아무 식별자 */
  key: string;
  /** 사람이 읽을 이름. 대상 행이 나중에 지워져도 무엇이었는지 남는다 */
  label?: string | null;
}

export async function recordGpcAssignment(args: {
  subject: GpcSubject;
  queryText: string;
  candidates: GpcCandidate[];
  verification: GpcVerification;
  imageReading?: ProductImageDescription | null;
}): Promise<void> {
  const db = getDb();
  const v = args.verification;

  await db`
    insert into public.gpc_assignment
      (subject_type, subject_key, subject_label, query_text, candidates,
       level, brick_code, brick_title, class_code, class_title,
       family_code, family_title, segment_code, segment_title,
       confidence, reasoning, model, image_reading)
    values (
      ${args.subject.type}, ${args.subject.key}, ${args.subject.label ?? null},
      ${args.queryText}, ${db.json(args.candidates as never)},
      ${v.level}, ${v.brickCode}, ${v.brickTitle}, ${v.classCode}, ${v.classTitle},
      ${v.familyCode}, ${v.familyTitle}, ${v.segmentCode}, ${v.segmentTitle},
      ${v.confidenceScore}, ${v.reasoning}, ${v.model},
      ${args.imageReading ? db.json(args.imageReading as never) : null}
    )
  `;
}

/** 한 대상의 가장 최근 판정. 화면이 「어떻게 붙었는지」를 펼쳐 보일 때 쓴다 */
export async function latestAssignment(subject: Pick<GpcSubject, 'type' | 'key'>) {
  const db = getDb();
  const [row] = await db<{
    query_text: string; candidates: GpcCandidate[]; level: string;
    brick_code: string | null; reasoning: string | null;
    confidence: string | null; model: string | null; created_at: string;
  }[]>`
    select query_text, candidates, level, brick_code, reasoning,
           confidence, model, created_at::text
    from public.gpc_assignment
    where subject_type = ${subject.type} and subject_key = ${subject.key}
    order by created_at desc limit 1
  `;
  return row ?? null;
}
