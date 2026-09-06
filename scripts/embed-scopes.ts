/**
 * 적용범위 임베딩 채우기
 *
 *   npm run scopes:embed          아직 없는 것만
 *   npm run scopes:embed -- --all 전부 다시
 *
 * 왜 미리 계산하나
 *   scope-semantic.ts 는 품목을 뜻으로 이을 때 적용범위 73개를 **호출마다** 다시
 *   임베딩했다. 사건 하나면 견딜 만하지만 법정 품목 187종을 배치로 이으려면
 *   73×187 번이 된다. 적용범위는 기준을 다시 적재하기 전에는 바뀌지 않는다.
 */

import { getDb, closeDb, toVectorLiteral } from '../src/lib/db';
import { embedBatch } from '../src/lib/llm/client';
import { openaiConfig } from '../src/lib/env';

/** 한 번에 몇 개씩 보낼 것인가. 적용범위는 길어야 1,500자라 넉넉하다 */
const CHUNK = 20;

async function main() {
  const all = process.argv.includes('--all');
  const db = getDb();
  const model = openaiConfig().embeddingModel;

  /*
    적용범위가 없으면 제목을 쓴다 (담당자 지적, 2026-09-06)

    등기구 3종(KC 60598-2-1·2-2·2-4)은 적용범위 원문이 0자다. 그래서 임베딩이 없었고,
    품목을 이을 때 후보에조차 들어가지 못했다 — LED등기구 사고 5건이 막혀 있던 이유다.

    그런데 제목은 명확하다.
      제2-1부: 고정형 등기구-개별요구사항
      제2-2부: 매입형 등기구-개별요구사항
      제2-4부: 이동형 등기구-개별요구사항

    적용범위만큼 자세하지는 않지만 어느 품목인지는 충분히 말해 준다. 없는 것보다 낫고,
    무엇으로 만든 벡터인지는 scope_source 로 남겨 나중에 구분할 수 있게 한다.
  */
  const rows = await db<{ id: number; display_name: string; body: string; src: string }[]>`
    select id, display_name,
           case when length(btrim(coalesce(scope_text, ''))) > 20
                then scope_text else coalesce(title_ko, '') end as body,
           case when length(btrim(coalesce(scope_text, ''))) > 20
                then '적용범위' else '제목' end as src
    from public.standard
    where is_current
      and (length(btrim(coalesce(scope_text, ''))) > 20
           or length(btrim(coalesce(title_ko, ''))) > 5)
      ${all ? db`` : db`and (scope_embedding is null or scope_embedding_model is distinct from ${model})`}
    order by display_name
  `;

  if (rows.length === 0) {
    console.log('채울 것이 없습니다. 전부 다시 하려면 --all 을 붙이세요.');
    return;
  }
  console.log(`적용범위 ${rows.length}종을 임베딩합니다 (모델 ${model})`);

  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    // scope-semantic 이 쓰던 것과 같은 형태로 만든다 — 기준 이름을 앞에 붙인다.
    // 형태가 어긋나면 저장한 벡터와 그때그때 만든 벡터가 다른 좌표가 된다
    const vectors = await embedBatch(
      chunk.map((r) => `${r.display_name}\n${r.body.slice(0, 1500)}`),
    );
    for (let j = 0; j < chunk.length; j++) {
      await db`
        update public.standard
        set scope_embedding = ${toVectorLiteral(vectors[j])}::extensions.vector(1536),
            scope_embedding_model = ${model},
            scope_embedded_at = now()
        where id = ${chunk[j].id}
      `;
    }
    done += chunk.length;
    console.log(`  ${done}/${rows.length}`);
  }

  const [s] = await db<{ n: string; models: string }[]>`
    select count(*)::text n, count(distinct scope_embedding_model)::text models
    from public.standard where scope_embedding is not null
  `;
  console.log('');
  console.log(`적용범위 임베딩 ${s.n}종 · 모델 ${s.models}종`);
  if (Number(s.models) > 1) {
    console.log('주의: 모델이 섞여 있습니다. 좌표계가 달라 유사도가 조용히 망가집니다 — --all 로 다시 돌리세요.');
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
