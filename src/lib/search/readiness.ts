import { getDb } from '../db';

/**
 * 분석해도 되는 자료인가 — 한 곳에서 판정한다
 *
 * 무엇이 없었나 (02_1차 보완 및 구현 설계서 §9, 원 계획서 P0)
 *   설계문서는 "원문 확인·품목 확정·적용 기준 확정·원본 보관 완료"를 묶어
 *   분석 가능 상태로 삼자고 했는데, 실제 코드가 확인하던 것은 적용 기준 하나뿐이었다.
 *   원문을 아직 아무도 안 본 사고보고서도, 원본 PDF 가 사라진 건도 분석이 돌았다.
 *
 *   그러면 결과 자체는 나온다. 문제는 그 결과가 어떤 자료에서 나왔는지 담당자가
 *   알 수 없다는 것이다 — 이 체계가 지키기로 한 것이 바로 그 되짚기다.
 *
 * 왜 트랙마다 조건이 다른가 (실측으로 정한 것)
 *   처음에는 is_confirmed 하나로 일괄 판정하려 했다. 그런데 세어 보니
 *   리콜 2,259건이 전부 is_confirmed = false 였고, 리콜 화면에는 확인 버튼이
 *   아예 없다. 일괄 게이트를 걸면 리콜 분석이 통째로 막힌다.
 *
 *   두 트랙에서 "확인"의 뜻이 다르기 때문이다.
 *
 *     사고보고서  PDF 에서 뽑은 글자가 제대로인지 사람이 눈으로 봐야 한다.
 *                 표가 뭉개졌는지는 기계가 모른다 → is_confirmed 가 그 표시다.
 *     리콜        협회 관리자가 검토·승인(approval_status='approved')한 것만
 *                 받아 온다(fetchApprovedRecalls). 우리 쪽에 다시 확인할 원문이
 *                 없다 → is_confirmed 는 이 트랙에서 뜻이 없는 칸이다.
 *
 *   그래서 트랙별로 나눈다. 없는 절차를 있는 것처럼 요구하면, 담당자는 뜻 없는
 *   버튼을 2,259번 누르거나 게이트를 꺼 버리게 된다.
 *
 * 막지 않고 알리는 것과의 차이
 *   품목·기준 미확정은 예전부터 실행을 막았다(v0.7 §3.2 — 전 기준을 뒤지면 다른
 *   제품의 시험이 섞인다). 여기서 더하는 것들도 같은 급이다. 다만 "왜 막혔는가"를
 *   사유별로 돌려주어야 담당자가 다음에 무엇을 할지 안다.
 */

/** 분석을 막는 사유. 화면과 명령줄이 같은 말을 쓰게 하려고 코드로 둔다 */
export type NotReadyReason =
  /** 품목에 대응하는 기준을 찾지 못했다 (v0.7 §3.2) */
  | 'SCOPE_UNRESOLVED'
  /** 사고보고서 원문을 담당자가 아직 확인하지 않았다 */
  | 'SOURCE_UNCONFIRMED'
  /** 원본 파일이 보관돼 있지 않다 — 결과에서 원문으로 되짚을 수 없다 */
  | 'ORIGINAL_MISSING'
  /** 위해요인 코드가 아직 없다 */
  | 'NOT_CODED';

export const NOT_READY_LABEL: Record<NotReadyReason, string> = {
  SCOPE_UNRESOLVED: '품목에 대응하는 안전기준을 찾지 못했습니다',
  SOURCE_UNCONFIRMED: '원문을 아직 확인하지 않았습니다',
  ORIGINAL_MISSING: '원본 파일이 보관돼 있지 않습니다',
  NOT_CODED: '위해요인 코드가 아직 없습니다',
};

/** 담당자가 다음에 무엇을 하면 되는가 */
export const NOT_READY_ACTION: Record<NotReadyReason, string> = {
  SCOPE_UNRESOLVED: '품목명을 확인하거나 적용할 기준을 지정해 주세요.',
  SOURCE_UNCONFIRMED: '사고보고서 화면에서 뽑아낸 원문을 보고 「원문 확인」을 눌러 주세요.',
  ORIGINAL_MISSING: '원본 PDF 를 다시 올려 주세요. 보관에 실패한 파일은 다시 올리면 이어받습니다.',
  NOT_CODED: '위해요인 코드를 먼저 부여해야 합니다.',
};

export interface Readiness {
  ready: boolean;
  reasons: NotReadyReason[];
}

/**
 * 사건 하나가 분석 가능한 상태인지 본다.
 *
 * 적용 기준(SCOPE_UNRESOLVED)은 여기서 보지 않는다 — 그것은 품목 해석까지
 * 거쳐야 알 수 있어서 runAnalysis 가 이미 따로 판정하고 있다. 여기서는 자료
 * 자체의 상태만 본다.
 */
export async function checkReadiness(caseId: number): Promise<Readiness> {
  const db = getDb();

  const [row] = await db<{
    source_type: string;
    is_confirmed: boolean;
    has_source_file: boolean;
    has_storage: boolean;
    tag_count: number;
  }[]>`
    select
      e.source_type,
      e.is_confirmed,
      (e.source_file_id is not null)                       as has_source_file,
      (f.storage_path is not null)                         as has_storage,
      (select count(*)::int from public.case_tag t
        where t.case_id = e.id and t.review_status <> 'rejected') as tag_count
    from public.case_event e
    left join public.source_file f on f.id = e.source_file_id
    where e.id = ${caseId}
  `;
  if (!row) throw new Error(`사건 ${caseId} 이 없습니다.`);

  const reasons: NotReadyReason[] = [];

  // 사고보고서 트랙에만 해당하는 두 가지.
  // 리콜은 원본이 협회 시스템에 있고 우리 쪽에 파일이 없다 — 없는 것을 요구하지 않는다.
  if (row.source_type === 'ACCIDENT') {
    if (!row.is_confirmed) reasons.push('SOURCE_UNCONFIRMED');
    if (row.has_source_file && !row.has_storage) reasons.push('ORIGINAL_MISSING');
  }

  if (row.tag_count === 0) reasons.push('NOT_CODED');

  return { ready: reasons.length === 0, reasons };
}
