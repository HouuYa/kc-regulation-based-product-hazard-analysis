/**
 * L3 임베딩 생성 배치
 *
 *   npm run embed                          임베딩이 없는 조항 전부
 *   npm run embed -- --standard "부속서 8"
 *   npm run embed -- --cases               사건(사고·리콜)도 함께
 *
 * 임베딩은 세 산출물 중 가장 싸다 (§3.4)
 *   HF/DT 코드는 LLM 호출 + 검수 시간이 들어 가장 비싸고,
 *   임베딩은 API 호출만 들고 검수가 필요 없다.
 *   그래서 검색 품질이 낮으면 코드 재태깅이 아니라 조립 규칙부터 손보는 것이 정답이다.
 *   "사진의 색감이 마음에 안 들 때 다시 인화하면 되지만, 피사체를 다시 불러
 *    촬영하는 것은 다른 차원의 일이다."
 *
 * 모델을 반드시 기록한다 (§2.2)
 *   embedding_model 이 없으면 모델을 바꾼 뒤 서로 다른 좌표계의 벡터가 한 테이블에
 *   섞여 검색이 조용히 망가진다. 같은 지도인 줄 알았는데 하나는 위경도,
 *   하나는 도로명 주소인 상황과 같다.
 */

import { getDb, closeDb, toVectorLiteral } from '../src/lib/db';
import { embedBatch } from '../src/lib/llm/client';
import { openaiConfig } from '../src/lib/env';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** 임베딩 API 는 한 번에 여러 건을 받는다. 너무 크면 요청이 거부되므로 나눠 보낸다 */
const BATCH = 64;

async function embedClauses(standardFilter: string | null) {
  const db = getDb();
  const cfg = openaiConfig();

  const rows = await db<{ id: number; search_text: string }[]>`
    select c.id, c.search_text
    from public.clause c
    join public.standard s on s.id = c.standard_id
    where c.embedding is null
      and c.search_text is not null
      and length(btrim(c.search_text)) > 0
      ${standardFilter ? db`and s.display_name ilike ${'%' + standardFilter + '%'}` : db``}
    order by c.id
  `;

  console.log(`조항 임베딩 대상 : ${rows.length}건 (모델 ${cfg.embeddingModel})`);
  if (rows.length === 0) return 0;

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vectors = await embedBatch(chunk.map((r) => r.search_text));

    await db.begin(async (tx) => {
      for (const [j, r] of chunk.entries()) {
        await tx`
          update public.clause
          set embedding       = ${toVectorLiteral(vectors[j])}::extensions.vector(1536),
              embedding_model = ${cfg.embeddingModel},
              embedded_at     = now()
          where id = ${r.id}
        `;
      }
    });

    done += chunk.length;
    process.stdout.write(`  진행 ${done}/${rows.length}\n`);
  }
  return done;
}

async function embedCases() {
  const db = getDb();
  const cfg = openaiConfig();

  const rows = await db<{ id: number; search_text: string }[]>`
    select id, search_text
    from public.case_event
    where embedding is null
      and search_text is not null
      and length(btrim(search_text)) > 0
    order by id
  `;

  console.log(`사건 임베딩 대상 : ${rows.length}건`);
  if (rows.length === 0) return 0;

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vectors = await embedBatch(chunk.map((r) => r.search_text));
    await db.begin(async (tx) => {
      for (const [j, r] of chunk.entries()) {
        await tx`
          update public.case_event
          set embedding       = ${toVectorLiteral(vectors[j])}::extensions.vector(1536),
              embedding_model = ${cfg.embeddingModel}
          where id = ${r.id}
        `;
      }
    });
    done += chunk.length;
  }
  return done;
}

async function main() {
  const standardFilter = argValue('--standard');
  const clauses = await embedClauses(standardFilter);
  const cases = process.argv.includes('--cases') ? await embedCases() : 0;

  console.log('');
  console.log(`임베딩 완료 : 조항 ${clauses}건${cases ? ` / 사건 ${cases}건` : ''}`);

  // 모델이 섞여 있으면 검색이 조용히 망가진다. 배치가 끝날 때마다 확인한다.
  const db = getDb();
  const models = await db<{ embedding_model: string; n: number }[]>`
    select embedding_model, count(*)::int as n
    from public.clause
    where embedding is not null
    group by embedding_model
  `;
  if (models.length > 1) {
    console.warn('');
    console.warn('경고: 서로 다른 임베딩 모델의 벡터가 섞여 있습니다.');
    for (const m of models) console.warn(`  ${m.embedding_model}: ${m.n}건`);
    console.warn('같은 좌표계가 아니므로 검색 결과를 신뢰할 수 없습니다. 전량 재생성하세요.');
  } else if (models.length === 1) {
    console.log(`저장된 벡터 : ${models[0].n}건 (${models[0].embedding_model})`);
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
