/**
 * 분석 결과 내려받기 (04-1 2단계)
 *
 * 왜 필요한가
 *   담당자가 화면에서 조항을 확인한 다음에 하는 일은 시험 의뢰서를 쓰는 것이다.
 *   그 자리에서 조항 번호를 손으로 옮겨 적게 두면 옮겨 적다 틀리고, 무엇보다
 *   화면 밖으로 나가는 순간 이 체계가 만든 근거가 사라진다.
 *
 * 두 목록을 한 파일에 담되 구분을 남긴다
 *   기본 목록은 피해유형을 다루는 조항이고, 원인 목록은 추정한 원인을 확인할
 *   시험이다. 성격이 다른 둘을 섞어 놓고 출처를 지우면 받는 사람이 판단할 수 없다.
 */

import { getDb } from '../db';
import { searchCandidates } from './match';
import { loadCaseInput, defaultMatchConfig } from './run';
import { withEstimatedCauses } from './estimate-cause';
import { toCsv } from '../csv';

const HEADER = [
  '구분', '순위', '기준', '조항번호', '위치', '본문',
  '검색점수', '재채점점수', '근거', '시험방법', '담당자판단',
] as const;

interface RunRow {
  marker: string;
  standard_name: string | null;
  breadcrumb_path: string | null;
  body: string;
  search_score: string | null;
  rerank_score: string | null;
  match_path: string;
  final_rank: number | null;
  decision: string | null;
  test_methods: string[] | null;
}

const DECISION_KO: Record<string, string> = {
  ADOPTED: '채택',
  REJECTED: '반려',
  PENDING: '보류',
};

export async function exportAnalysisCsv(caseId: number, picked: string[] = []): Promise<string> {
  const db = getDb();

  /*
    저장된 마지막 분석 결과를 읽는다. 화면이 보여 주는 것과 같은 것이어야 한다 —
    파일과 화면이 다르면 담당자는 둘 중 무엇을 믿을지 알 수 없다.
  */
  const rows = await db<RunRow[]>`
    select
      c.marker, s.display_name as standard_name, c.breadcrumb_path, c.body,
      mr.search_score::text, mr.rerank_score::text, mr.match_path, mr.final_rank,
      (select rl.decision from public.review_log rl
        where rl.match_result_id = mr.id order by rl.created_at desc limit 1) as decision,
      (select array_agg(distinct tc.marker order by tc.marker)
         from public.clause_link cl join public.clause tc on tc.id = cl.to_clause_id
        where cl.from_clause_id = c.id and cl.link_type = 'TEST_METHOD') as test_methods
    from public.match_result mr
    join public.clause c on c.id = mr.clause_id
    join public.standard s on s.id = c.standard_id
    where mr.run_id = (
      select id from public.match_run where case_id = ${caseId}
      order by started_at desc limit 1
    )
    order by mr.final_rank nulls last, mr.search_score desc
  `;

  const out: Array<Array<string | number | null>> = rows.map((r, i) => [
    '기본(피해유형)', r.final_rank ?? i + 1, r.standard_name, r.marker,
    r.breadcrumb_path, r.body,
    r.search_score ? Number(r.search_score).toFixed(4) : '',
    r.rerank_score ? Number(r.rerank_score).toFixed(2) : '',
    r.match_path,
    (r.test_methods ?? []).join(' · '),
    r.decision ? (DECISION_KO[r.decision] ?? r.decision) : '',
  ]);

  // 담당자가 원인을 고른 채로 내려받으면 그 목록도 함께 담는다.
  // 화면에서 본 것이 그대로 파일에 있어야 한다
  if (picked.length > 0) {
    const est = await withEstimatedCauses(await loadCaseInput(caseId), { picked });
    if (est.candidates.length > 0) {
      const found = await searchCandidates(est.input, defaultMatchConfig({ useRerank: false }));
      const names = est.candidates.map((c) => c.nameKo ?? c.hfCode).join(' · ');
      found.forEach((c, i) => {
        out.push([
          `원인(${names})`, i + 1, c.standardName, c.marker,
          c.breadcrumbPath, c.body, c.score.toFixed(4), '', c.matchPath,
          c.testMethods.map((t) => t.marker).join(' · '),
          '', // 원인 목록은 저장하지 않으므로 판단 기록이 붙지 않는다
        ]);
      });
    }
  }

  return toCsv(HEADER, out);
}
