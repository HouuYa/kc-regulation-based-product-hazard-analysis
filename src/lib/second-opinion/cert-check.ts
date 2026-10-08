/**
 * 인증·표시(불법) 확인 항목 — 사고 사전 검토의 4번 결과 (06_02 P1-5)
 *
 * 왜 따로 만드나
 *   legal.ts 는 보고서의 「동일성 확인 결과」(인증기관 유권해석)에서만 신호를 낸다. 조사 전
 *   양식에는 그 칸이 비어 있으므로 아무것도 나오지 않는다. 조사 전에 필요한 것은 신호가
 *   아니라 **무엇을 확인해야 하는가**의 목록이다. 재료는 이미 있어서 묶기만 한다.
 *
 * 항목은 법령제도 문서의 구분을 그대로 따른다 (docs/wiki/개념/법령제도/)
 *   - 위반유형은 두 축이다 — 인증을 받았는가 / 표시를 했는가. 미인증·허위표시·미표시
 *     (불법과_불량_판정기준.md §4). 그래서 인증 여부와 표시 여부를 따로 묻는다.
 *   - 부품을 바꿨는지는 인증기관에 질의하는 동일성 확인으로 가린다
 *     (동일성확인_인증기관_유권해석.md). 시험 후보가 아니라 이쪽 항목이다(CLAUDE.md §10).
 *   - 세부 표시사항은 KC안전기준 안에 있어도, 지키지 않은 것은 표시 의무 위반 — 불법이다.
 *
 * 판정하지 않는다. 확인할 항목과 그 근거만 낸다. 인증 구분별 의무를 이 파일이 새로
 * 지어내지 않는다 — 위 문서에 있는 것만 쓴다.
 */
import { getDb } from '../db';
import { intakePortion } from './narrative';
import { loadApplicableClauses, groupSections } from './coverage';

export interface CertType {
  value: string;
  /** 어디서 알았나 — 보고서 양식이 가장 확실하고, 없으면 적용 기준의 인증 구분으로 물러난다 */
  source: '보고서 양식' | '적용 기준';
}

export interface CertCheckItem {
  key: 'CERT' | 'MARK' | 'IDENTITY' | 'MARKING_CLAUSES';
  label: string;
  why: string;
}

export interface CertCheck {
  certTypes: CertType[];
  items: CertCheckItem[];
  /** 적용 기준의 표시 조항 — 절 단위 */
  markingSections: Array<{ standardName: string | null; section: string; title: string; clauses: number }>;
  /** 조사 뒤에만 — 보고서가 적은 동일성 확인 결과 */
  identityResults: Array<{ verdict: string | null; label: string }>;
  /** 조사 뒤에만 — 병행 점검이 낸 불법 신호 수 */
  legalSignals: number;
}

/**
 * 양식에서 인증 구분을 읽는다. 표기가 두 가지다 (전기용품 43건 실측)
 *   인증 정보 칸   "(안전인증대상 전기용품)"
 *   품목분류 칸    "전기용품>안전확인 > 정보·통신·사무기기" — 새 양식. 앞의 것만 읽으면 보조배터리 3건이
 *                  「알 수 없음」이 되어 동일성 확인 항목이 빠졌다(실제로는 3건 모두 「상이함」)
 */
const CERT_IN_FORM =
  /(안전인증|안전확인|공급자\s?적합성\s?확인|안전기준\s?준수|안전성\s?검사)\s?대상|(?:전기용품|생활용품|어린이제품)\s?>\s?(안전인증|안전확인|공급자\s?적합성\s?확인|안전기준\s?준수)/g;

function normCert(s: string): string {
  return s.replace(/\s+/g, '').replace(/^공급자적합성$/, '공급자적합성확인');
}

/** 인증기관이 인증 당시 모델과 견줄 수 있는 구분 — 동일성 확인은 인증기관 질의다 */
const CERTIFIED = new Set(['안전인증', '안전확인']);

/**
 * standardIds 는 호출자가 넘긴다 — standardsForCase() 는 사전에 없는 품목이면 LLM 의미 검색까지
 * 가므로, 여기서 또 부르면 화면 한 번에 AI 호출이 겹친다. 사건 화면은 이미 그 목록을 갖고 있다.
 */
export async function buildCertCheck(caseId: number, standardIds: number[]): Promise<CertCheck> {
  const db = getDb();
  const [ev] = await db<{ narrative: string }[]>`
    select narrative from public.case_event where id = ${caseId}
  `;

  // 1) 인증 구분 — 양식의 제품정보 칸(조사 전에도 있는 부분)에서 먼저 찾는다
  const head = intakePortion(ev?.narrative ?? '')?.text ?? (ev?.narrative ?? '').slice(0, 1500);
  const fromForm = [...new Set([...head.matchAll(CERT_IN_FORM)].map((m) => normCert(m[1] ?? m[2])))];
  let certTypes: CertType[] = fromForm.map((value) => ({ value, source: '보고서 양식' as const }));
  if (certTypes.length === 0 && standardIds.length > 0) {
    const rows = await db<{ c: string }[]>`
      select distinct unnest(cert_types) as c from public.standard
      where id = any(${standardIds}) and cert_types is not null
    `;
    certTypes = rows.map((r) => ({ value: normCert(r.c), source: '적용 기준' as const }));
  }

  // 2) 표시 조항 — 시험 후보와 섞지 않으려고 coverage.ts 가 이미 갈라 둔 것을 쓴다
  const { marking } = await loadApplicableClauses(standardIds);
  const markingSections = [...groupSections(marking).values()].map((s) => ({
    standardName: s.standardName, section: s.section, title: s.title, clauses: s.clauseIds.length,
  }));

  // 3) 조사 뒤 — 보고서가 적은 동일성 확인 결과와 불법 신호 (가장 최근 병행 점검)
  const [run] = await db<{ id: number }[]>`
    select id from public.second_opinion_run where case_id = ${caseId}
    order by started_at desc, id desc limit 1
  `;
  const identityResults = run
    ? await db<{ verdict: string | null; label: string }[]>`
        select verdict, label from public.case_investigation_item
        where run_id = ${run.id} and item_type = 'IDENTITY_CHECK'
      `
    : [];
  const [legal] = run
    ? await db<{ n: number }[]>`
        select count(*)::int n from public.second_opinion_finding
        where run_id = ${run.id} and finding_type = 'LEGAL_SIGNAL'
      `
    : [{ n: 0 }];

  const certNames = certTypes.map((c) => c.value).join('·') || '알 수 없음';
  const certified = certTypes.some((c) => CERTIFIED.has(c.value));
  const items: CertCheckItem[] = [
    {
      key: 'CERT',
      label: `인증 여부 확인 — ${certNames}`,
      why: '인증을 받지 않고 제조·수입했으면 미인증이다(불법과_불량_판정기준.md §4). 인증 정보 조회로 확인한다',
    },
    {
      key: 'MARK',
      label: 'KC 표시 확인',
      why: '인증을 받지 않고 표시했으면 허위표시, 받았는데 표시하지 않았으면 미표시다 — 인증 여부와 별개의 축이다',
    },
  ];
  if (certified) {
    items.push({
      key: 'IDENTITY',
      label: '동일성 확인 의뢰 — 인증 당시 모델과 같은가',
      why: '부품 변경은 인증기관에 질의해 받는 유권해석으로 가린다. 시험 후보가 아니다(동일성확인_인증기관_유권해석.md)',
    });
  }
  if (markingSections.length > 0) {
    items.push({
      key: 'MARKING_CLAUSES',
      label: `적용 기준의 세부 표시사항 ${markingSections.length}개 절`,
      why: '기준 안에 있어도 지키지 않은 것은 표시 의무 위반 — 불법이다(CLAUDE.md §10)',
    });
  }

  return { certTypes, items, markingSections, identityResults, legalSignals: legal?.n ?? 0 };
}
