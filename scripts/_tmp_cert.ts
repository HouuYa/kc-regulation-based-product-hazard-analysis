import { closeDb } from '../src/lib/db';
import { buildCertCheck } from '../src/lib/second-opinion/cert-check';
import { getDb } from '../src/lib/db';
import { accidentIdsInGroup } from '../src/lib/eval/pre-review';
async function main() {
  const ids = await accidentIdsInGroup('전기용품');
  const src: Record<string, number> = {}; let identity = 0, idDiff = 0, marking = 0, legalCases = 0, missedDiff: number[] = [];
  for (const id of ids) {
    const [ev] = await getDb()<{ standard_ids: number[] | null }[]>`select standard_ids from public.second_opinion_run where case_id = ${id} order by started_at desc, id desc limit 1`;
    const c = await buildCertCheck(id, (ev?.standard_ids ?? []).map(Number));
    const k = c.certTypes.length ? c.certTypes[0].source : '없음'; src[k] = (src[k] ?? 0) + 1;
    const hasId = c.items.some((i) => i.key === 'IDENTITY'); if (hasId) identity++;
    const diff = c.identityResults.some((r) => r.verdict === '상이함'); if (diff) { idDiff++; if (!hasId) missedDiff.push(id); }
    if (c.markingSections.length) marking++; if (c.legalSignals) legalCases++;
  }
  console.log({ cases: ids.length, certSource: src, identityItem: identity, reportsSaidDiffer: idDiff, differButNoIdentityItem: missedDiff, withMarkingClauses: marking, withLegalSignals: legalCases });
  await closeDb();
}
main();
