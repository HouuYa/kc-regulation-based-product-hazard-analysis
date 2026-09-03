/**
 * L1 조항 태깅 배치
 *
 *   npm run tag -- --standard "부속서 8"        기준 하나
 *   npm run tag -- --standard "부속서 8" --limit 20
 *   npm run tag -- --standard "부속서 8" --dry   호출 없이 대상만 센다
 *   npm run tag -- --retag                       이미 태깅된 조항도 다시
 *
 * 실행부는 src/lib/standards/tag-run.ts 에 있다
 *   운영 화면에 「코드 부여 실행」 버튼이 생기면서 명령줄과 화면이 같은 로직을
 *   쓰게 됐다(CLAUDE.md §9). 여기서는 인자 해석과 출력만 맡는다.
 *
 *   대량 처리는 여전히 이 명령줄이 낫다. 화면 버튼은 서버리스 실행 시간 안에
 *   들어와야 해서 한 번에 조금씩만 처리한다.
 */

import { closeDb } from '../src/lib/db';
import { runTagging, countTaggable } from '../src/lib/standards/tag-run';
import { openaiConfig, tuning } from '../src/lib/env';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const standardFilter = argValue('--standard');
  const limit = Number(argValue('--limit') ?? '0') || null;
  const dry = process.argv.includes('--dry');
  const retag = process.argv.includes('--retag');

  const t = tuning();
  const cfg = openaiConfig();

  if (dry) {
    const n = await countTaggable(standardFilter, retag);
    console.log(`태깅 대상 : ${n}건${standardFilter ? ` (${standardFilter})` : ''}`);
    console.log('(--dry) 호출하지 않고 종료합니다.');
    return;
  }

  console.log(`조립 변형 : ${t.searchTextVariant}`);
  console.log(`1차 모델  : ${cfg.bulkModel} (reasoning ${cfg.bulkEffort}) × ${t.bulkRepeat}회`);
  console.log(`승격 모델 : ${cfg.escalateModel} (reasoning ${cfg.escalateEffort}) — 일치도 ${t.escalateBelowAgreement} 미만일 때`);

  const r = await runTagging({
    standardFilter,
    limit,
    retag,
    onProgress: (done, total, ok, fail) => {
      if (done % 20 === 0 || done === total) {
        process.stdout.write(`  진행 ${done}/${total} (성공 ${ok} 실패 ${fail})\n`);
      }
    },
  });

  console.log(`태깅 대상 : ${r.target}건${standardFilter ? ` (${standardFilter})` : ''}`);
  console.log(`코드북    : ${r.codebookVersion}`);
  for (const e of r.errors) console.error(`  ${e}`);

  console.log('');
  console.log(`태깅 완료 : 성공 ${r.ok} / 실패 ${r.fail} (tagging_version = ${r.taggingVersion})`);

  // 2단 구조가 실제로 어떻게 갈렸는지 남긴다.
  // 승격률이 예상(15%)보다 훨씬 높으면 1차 모델이나 프롬프트를 손봐야 한다는 신호이고,
  // 반대로 0% 에 가까우면 승격 임계값이 느슨한 것이다.
  if (r.ok > 0) {
    const rate = ((r.escalated / r.ok) * 100).toFixed(1);
    console.log(`승격      : ${r.escalated}/${r.ok}건 (${rate}%) — 1차 반복이 일치하지 않아 상위 모델로`);
    console.log(`  그중 상위 모델이 1차 다수결과 다른 답 : ${r.disagreed}건`);
    if (r.disagreed > 0) {
      console.log('  이 건들이 검수 최우선 대상입니다(§5.2.3 "가장 위험한 구간").');
    }
  }
  console.log(
    `토큰      : 입력 ${r.usage.inputTokens.toLocaleString()} / ` +
      `출력 ${r.usage.outputTokens.toLocaleString()}` +
      `(사고 ${r.usage.reasoningTokens.toLocaleString()})`,
  );
  console.log('다음      : 검색용 텍스트가 바뀌었으므로 의미 검색 준비가 자동으로 다시 만들어집니다(1분 안에).');
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
