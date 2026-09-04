import { resolveScopeSemantically } from '../src/lib/cases/scope-semantic';
import { closeDb } from '../src/lib/db';

// 엑셀(사람이 결정한 것)에서 뽑은 품목 → 기준
const truth: Array<[string, string]> = [
  ['전기요', 'KC 60335-2-17'],
  ['전기매트', 'KC 60335-2-17'],
  ['전기방석', 'KC 60335-2-17'],
  ['전기레인지', 'KC 60335-2-6'],
  ['전동킥보드', '안전확인 부속서 72(전동보드)'],
  ['가습기', 'KC 60335-2-98'],
  ['완구', '안전확인 부속서 6(완구)'],
  ['전기자전거', '안전확인 부속서 40(이륜자전거)'],
  ['모발건조기', '안전확인 부속서 74(가정용 미용기기)'],
  ['전기머리인두', '안전확인 부속서 74(가정용 미용기기)'],
];

async function main() {
  let ok = 0, none = 0, wrong = 0;
  for (const [item, want] of truth) {
    const r = await resolveScopeSemantically(item);
    if (!r) { none++; console.log(`${item.padEnd(10)} → 없음        (정답 ${want})`); continue; }
    const hit = r.displayName === want;
    if (hit) ok++; else wrong++;
    console.log(`${item.padEnd(10)} → ${hit ? '맞음' : '틀림'}  ${r.displayName.padEnd(26)} 확신 ${r.confidence.toFixed(2)}${hit ? '' : `  (정답 ${want})`}`);
    if (!hit) console.log(`             근거: ${r.reasoning.slice(0, 110)}`);
  }
  console.log(`\n맞음 ${ok} / 틀림 ${wrong} / 없음 ${none}  (전체 ${truth.length})`);
  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
