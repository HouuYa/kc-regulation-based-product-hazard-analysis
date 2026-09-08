/**
 * 품목 용어 사전(scope_term) → GPC 브릭 배정
 *
 *   npm run terms:gpc                 아직 안 돌린 품목 전부
 *   npm run terms:gpc -- --limit 20   20건만
 *   npm run terms:gpc -- --dry        호출 없이 대상만 센다
 *   npm run terms:gpc -- --redo       이미 돌린 것도 다시
 *
 * 왜 만들었나
 *   담당자가 "(비대상)종아리마사지기가 GPC에 없다는 것이 이상한데, 자동 분류
 *   또는 LLM 분류 기능이 이상한 것 아니냐"고 물었다. 확인해 보니 분류기가 틀린
 *   것이 아니라 **한 번도 돌린 적이 없었다.** GPC가 붙어 있는 33종은 전부 담당자
 *   엑셀에 코드가 적혀 있던 것이고, 의미검색이 찾아낸 401종에는 아무도 배정을
 *   시도하지 않았다. 없는 것과 안 한 것은 다르다.
 *
 * 왜 GPC를 붙이나 — 기준을 고르려는 것이 아니다
 *   우리 사고는 한국어로, 해외 리콜은 영어로 적힌다. 「같은 종류의 제품」으로
 *   묶어 세려면 언어와 무관한 번호가 하나 필요하고 그 용도로만 쓴다.
 *   기준 선택에는 쓰지 않는다 — 한 브릭이 여러 품목을 묶는 4건 중 3건에서
 *   적용기준이 서로 달랐다(docs/전체_프로세스와_용어.md §4).
 *
 * 무엇을 조회 입력으로 넣나
 *   품목명만으로는 「L1LCRCA」 같은 모델 기호에서 아무것도 나오지 않는다.
 *   그래서 그 품목이 어느 기준에 이어져 있는지와, 의미검색이 그때 남긴 근거
 *   문장을 함께 넣는다. 근거 문장에는 "종아리에 착용·작동하여 압박·진동 등으로
 *   마사지를 제공하는" 처럼 제품이 무엇인지가 서술되어 있다 — GPC 브릭 설명과
 *   견주기에 품목명보다 훨씬 나은 재료다.
 *
 * 결과를 어떻게 남기나 (061)
 *   브릭까지 좁힌 것만 brick_code 를 채우고, 그 위에서 멈춘 것(세그먼트·패밀리·
 *   클래스)이나 맞는 것이 없다고 판단한 것도 행을 만들어 checked_at 을 남긴다.
 *   그래야 화면이 「아직 안 함」과 「돌렸으나 못 좁힘」을 구별해 말할 수 있다.
 *   전부 미검수로 넣는다 — 담당자 엑셀에서 온 확정분은 건드리지 않는다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { findAndVerifyGpc } from '../src/lib/gpc/assign';

interface TermRow {
  term_key: string;
  term: string;
  standards: string[];
  evidence: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const redo = args.includes('--redo');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : null;

  const db = getDb();

  /*
    대상 — 담당자가 확정한 GPC 는 절대 건드리지 않는다.
    --redo 를 줘도 EXPERT 는 빠진다. 사람이 정한 것을 AI 가 덮으면
    그 순간 이 표를 믿을 수 없게 된다.
  */
  const rows = await db<TermRow[]>`
    select t.term_key,
           min(t.term) as term,
           array_agg(distinct coalesce(s.item_name, s.title_ko, s.display_name)) as standards,
           (array_agg(t.evidence order by t.confidence desc nulls last))[1] as evidence
    from public.scope_term t
    join public.standard s on s.id = t.standard_id and s.is_current
    where t.review_status <> 'rejected'
      and not exists (
        select 1 from public.scope_term_gpc g
        where g.term_key = t.term_key
          and (g.source = 'EXPERT' or ${redo} = false)
      )
    group by t.term_key
    order by min(t.term)
    ${limit ? db`limit ${limit}` : db``}
  `;

  console.log(`대상 ${rows.length}종${dry ? ' (dry — 호출하지 않음)' : ''}`);
  if (dry || rows.length === 0) {
    for (const r of rows.slice(0, 10)) console.log(`  ${r.term}`);
    if (rows.length > 10) console.log(`  … 외 ${rows.length - 10}종`);
    await closeDb();
    return;
  }

  const tally = { BRICK: 0, CLASS: 0, FAMILY: 0, SEGMENT: 0, NONE: 0 } as Record<string, number>;
  let failed = 0;

  for (const [i, r] of rows.entries()) {
    const context = [
      `품목명: ${r.term}`,
      r.standards.length ? `적용되는 KC안전기준: ${r.standards.join(', ')}` : '',
      r.evidence ? `제품 설명: ${r.evidence}` : '',
    ].filter(Boolean).join('\n');

    try {
      const { verification } = await findAndVerifyGpc(r.term, context);
      const level = verification.level ?? 'NONE';
      tally[level] = (tally[level] ?? 0) + 1;

      await db`
        insert into public.scope_term_gpc
          (term_key, term, brick_code, source, evidence, confidence,
           review_status, verified_level, checked_at)
        values (
          ${r.term_key}, ${r.term},
          ${level === 'BRICK' ? verification.brickCode : null},
          'LLM', ${verification.reasoning}, ${verification.confidenceScore},
          'auto_unreviewed', ${level}, now()
        )
        on conflict (term_key) do update
          set brick_code     = excluded.brick_code,
              source         = 'LLM',
              evidence       = excluded.evidence,
              confidence     = excluded.confidence,
              review_status  = 'auto_unreviewed',
              verified_level = excluded.verified_level,
              checked_at     = now(),
              updated_at     = now()
        where public.scope_term_gpc.source <> 'EXPERT'
      `;

      const mark = level === 'BRICK' ? verification.brickCode : level;
      console.log(`[${i + 1}/${rows.length}] ${r.term} → ${mark}`);
    } catch (e) {
      failed++;
      console.error(`[${i + 1}/${rows.length}] ${r.term} 실패:`, e instanceof Error ? e.message : e);
    }
  }

  console.log('');
  console.log(`브릭까지 좁힘 ${tally.BRICK}건`);
  console.log(`그 위에서 멈춤 — 클래스 ${tally.CLASS} · 패밀리 ${tally.FAMILY} · 세그먼트 ${tally.SEGMENT}`);
  console.log(`맞는 것 없음 ${tally.NONE}건 · 실패 ${failed}건`);
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
