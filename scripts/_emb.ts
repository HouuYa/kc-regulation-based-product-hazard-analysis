import { embedBatch } from '../src/lib/llm/client';
import { getDb, closeDb } from '../src/lib/db';

const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

async function main() {
  const db = getDb();
  const stds = await db<{ id: number; display_name: string; scope_text: string }[]>`
    select id, display_name, scope_text from public.standard
    where is_current and scope_text is not null and length(btrim(scope_text)) > 20`;
  console.log(`적용범위가 있는 기준 ${stds.length}종 임베딩`);

  const vecs = await embedBatch(stds.map((s) => `${s.display_name}\n${s.scope_text.slice(0, 1500)}`));
  const items = ['전기요','전기레인지','전동킥보드','전기방석','직류전원장치','전기매트','가습기'];
  const iv = await embedBatch(items);

  // 엑셀이 알려 준 정답
  const truth: Record<string, string> = {
    '전기요': 'KC 60335-2-17', '전기레인지': 'KC 60335-2-6',
    '전동킥보드': '안전확인 부속서 72(전동보드)', '전기매트': 'KC 60335-2-17',
    '가습기': 'KC 60335-2-98',
  };

  for (let i = 0; i < items.length; i++) {
    const ranked = stds.map((s, j) => ({ n: s.display_name, sim: cos(iv[i], vecs[j]) }))
      .sort((a, b) => b.sim - a.sim);
    const want = truth[items[i]];
    const rank = want ? ranked.findIndex((r) => r.n === want) + 1 : 0;
    console.log(`\n${items[i]}  ${want ? `(정답 ${want} → ${rank ? `${rank}위` : '없음'})` : ''}`);
    for (const r of ranked.slice(0, 4)) console.log(`    ${r.sim.toFixed(3)}  ${r.n}`);
  }
  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
