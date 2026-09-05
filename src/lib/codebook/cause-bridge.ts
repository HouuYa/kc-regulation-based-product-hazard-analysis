/**
 * 결과에서 원인으로 가는 다리 (04-1 문서)
 *
 * 무엇을 푸는가
 *   사고조사보고서 70건 중 54건(77%)이 원인 미상이다. 원인 코드가 없으니 시스템은
 *   피해유형으로만 조항을 찾고, 그러면 "화재 조항"은 찾지만 "화재의 원인을 확인할
 *   시험"은 못 찾는다. 담당자가 지목한 내습성·누설전류를 놓치는 이유가 이것이다.
 *
 * 어떻게 채우는가
 *   해외 리콜 2,299건 중 2,072건에는 원인이 적혀 있다. 사고보고서와 달리 리콜은
 *   원인이 밝혀진 자료다. "어떤 피해에 어떤 원인이 따라왔는가"를 세면 사전이 된다.
 *
 * 왜 빈도가 아니라 리프트인가
 *   설계결함은 화재와 116건 함께 나오지만 어느 사고에나 붙는 코드다(전체 629건).
 *   화재에서 설계결함이 보인다는 사실은 아무것도 알려 주지 않는다. 반면 과열은
 *   전체 309건 중 243건이 화재와 함께 나온다 — 이건 화재의 표지다.
 *   리프트는 그 차이를 재는 값이고, 실측에서 설계결함은 0.96 으로 저절로 밀린다.
 */

import { getDb } from '../db';

/** 근거가 이보다 얇으면 담지 않는다. 없으면 1건짜리 우연이 리프트 최상위를 차지한다 */
export const MIN_SUPPORT = 5;

/** 사전을 만드는 자료. 사고보고서는 77%가 원인 미상이라 셀 것이 없어 제외한다 */
const SOURCE = 'RECALL';

export type CauseRoute = 'TEST' | 'LEGAL' | 'GAP' | 'OTHER';

export interface CauseCandidate {
  hfCode: string;
  nameKo: string | null;
  /** 무엇으로 확인하는가. TEST 만 시험항목 도출 대상이다 */
  route: CauseRoute;
  /** 함께 나온 사건 수 */
  support: number;
  /** 이 피해일 때 이 원인이 나온 비율 */
  confidence: number;
  /** 특이성 — 1 근처면 그 피해와 무관하게 원래 흔한 원인이다 */
  lift: number;
  sampleSize: number;
}

export interface BuildResult {
  /** 계산에 쓴 사건 수 */
  cases: number;
  /** 담은 줄 수 */
  rows: number;
  /** 근거가 얇아 버린 줄 수 */
  dropped: number;
}

/**
 * 리콜 자료를 세어 다리를 다시 만든다.
 *
 * 통째로 지우고 다시 넣는다. 리콜이 쌓이면 모든 줄의 분모가 함께 바뀌므로,
 * 일부만 갱신하면 옛 표본으로 계산된 줄과 새 표본으로 계산된 줄이 섞인다.
 */
export async function buildCauseBridge(minSupport = MIN_SUPPORT): Promise<BuildResult> {
  const db = getDb();

  const [{ n: cases }] = await db<{ n: string }[]>`
    select count(*)::text n from public.case_event where source_type <> 'ACCIDENT'
  `;

  /*
    한 질의로 계산한다 (설계문서 §1.1 원칙 2 — 판단은 DB 가 한다).

    HF.UNKNOWN 은 제외한다. "원인을 모른다"는 뜻이라 원인 후보가 될 수 없다.
    같은 이유로 사고보고서(ACCIDENT)도 제외한다 — 77%가 UNKNOWN 이라 세면
    분포가 아니라 결측을 세게 된다.
  */
  const rows = await db<{
    dt_code: string; hf_code: string; support: string;
    confidence: string; lift: string; sample_size: string;
  }[]>`
    with src as (
      select id from public.case_event where source_type <> 'ACCIDENT'
    ),
    -- 원인 코드가 붙은 사건 전체. 리프트의 분모(평소 비율)를 여기서 낸다
    hf as (
      select t.case_id, t.code
      from public.case_tag t join src on src.id = t.case_id
      where t.axis = 'HF' and t.code <> 'HF.UNKNOWN' and t.review_status <> 'rejected'
    ),
    dt as (
      select t.case_id, t.code
      from public.case_tag t join src on src.id = t.case_id
      where t.axis = 'DT' and t.review_status <> 'rejected'
    ),
    total as (select count(distinct case_id)::numeric n from hf),
    hf_base as (
      select code, count(distinct case_id)::numeric n from hf group by code
    ),
    dt_base as (
      select code, count(distinct case_id)::numeric n from dt group by code
    ),
    joint as (
      select dt.code dt_code, hf.code hf_code, count(distinct hf.case_id)::numeric n
      from dt join hf on hf.case_id = dt.case_id
      group by dt.code, hf.code
    )
    select
      j.dt_code,
      j.hf_code,
      j.n::text                                        support,
      round(j.n / d.n, 4)::text                        confidence,
      round((j.n / d.n) / (h.n / t.n), 3)::text        lift,
      d.n::text                                        sample_size
    from joint j
    join dt_base d on d.code = j.dt_code
    join hf_base h on h.code = j.hf_code
    cross join total t
    where j.n >= ${minSupport}
    order by j.dt_code, (j.n / d.n) / (h.n / t.n) desc
  `;

  const [{ n: all }] = await db<{ n: string }[]>`
    with src as (select id from public.case_event where source_type <> 'ACCIDENT'),
    hf as (
      select t.case_id, t.code from public.case_tag t join src on src.id = t.case_id
      where t.axis = 'HF' and t.code <> 'HF.UNKNOWN' and t.review_status <> 'rejected'
    ),
    dt as (
      select t.case_id, t.code from public.case_tag t join src on src.id = t.case_id
      where t.axis = 'DT' and t.review_status <> 'rejected'
    )
    select count(*)::text n from (
      select dt.code, hf.code from dt join hf on hf.case_id = dt.case_id
      group by dt.code, hf.code
    ) x
  `;

  await db.begin(async (tx) => {
    await tx`delete from codebook.cause_bridge where source = ${SOURCE}`;
    for (const r of rows) {
      await tx`
        insert into codebook.cause_bridge
          (dt_code, hf_code, source, support, confidence, lift, sample_size, computed_at)
        values (${r.dt_code}, ${r.hf_code}, ${SOURCE}, ${Number(r.support)},
                ${r.confidence}, ${r.lift}, ${Number(r.sample_size)}, now())
      `;
    }
  });

  return { cases: Number(cases), rows: rows.length, dropped: Number(all) - rows.length };
}

/**
 * 피해유형에서 원인 후보를 읽어 온다.
 *
 * 기본은 시험으로 확인할 수 있는 원인(TEST)만 돌려준다. 불법·기준공백은 담겨 있지만
 * 시험항목을 고르는 자리에서는 섞이면 안 되기 때문이다 — 불법 제조 여부를 판정하는
 * 시험 조항은 없다. 다른 출구에서 쓰려면 route 를 지정해 부른다.
 */
export async function estimateCauses(
  dtCodes: string[],
  opts: { routes?: CauseRoute[]; limit?: number; minLift?: number } = {},
): Promise<CauseCandidate[]> {
  if (dtCodes.length === 0) return [];
  const db = getDb();
  const routes = opts.routes ?? ['TEST'];
  // 리프트 1 은 "그 피해와 상관없이 원래 흔한 원인"이라는 뜻이다. 그 아래는 후보가 아니다
  const minLift = opts.minLift ?? 1;

  const rows = await db<{
    hf_code: string; name_ko: string | null; route: CauseRoute;
    support: string; confidence: string; lift: string; sample_size: string;
  }[]>`
    select
      b.hf_code, h.name_ko, r.route,
      -- 같은 원인이 여러 피해에 걸리면 가장 강한 근거를 취한다
      max(b.support)::text     support,
      max(b.confidence)::text  confidence,
      max(b.lift)::text        lift,
      max(b.sample_size)::text sample_size
    from codebook.cause_bridge b
    join codebook.hf_route r on r.code = b.hf_code
    left join codebook.hazard_factor h
      on h.code = b.hf_code
     and h.version_id = (select id from codebook.version where status = 'active')
    where b.dt_code = any(${dtCodes})
      and r.route = any(${routes})
      and b.lift >= ${minLift}
    group by b.hf_code, h.name_ko, r.route
    /*
      리프트는 거르는 조건이고, 순위는 신뢰도로 매긴다 (2026-09-05 실측으로 고침).

      리프트로 줄 세웠더니 얇은 코드가 위를 차지했다. 화재의 상위 5가
      비화재 열적사고(31건) · 과열(240건) · 보호회로 부재(14건) · 배터리(77건) ·
      하드웨어(9건) 였고, 정작 절연 불량(158건 · 38.6%)이 7위로 밀려 사건 5553 의
      내습성·누설전류를 못 찾았다. 리프트는 드문 코드일수록 커지기 때문이다.

      신뢰도로 세우면 과열(58.7%) 다음이 절연 불량(38.6%)이다. 담당자가 화재를
      보고 떠올리는 순서에 가깝다. 리프트는 "이 피해와 무관하게 원래 흔한 원인"을
      쳐내는 문지기로 남는다 — 설계결함(리프트 0.96)이 그렇게 걸러진다.
    */
    order by max(b.confidence) desc
    limit ${opts.limit ?? 10}
  `;

  return rows.map((r) => ({
    hfCode: r.hf_code,
    nameKo: r.name_ko,
    route: r.route,
    support: Number(r.support),
    confidence: Number(r.confidence),
    lift: Number(r.lift),
    sampleSize: Number(r.sample_size),
  }));
}

export interface BridgeRow {
  dtCode: string;
  dtName: string | null;
  hfCode: string;
  hfName: string | null;
  route: CauseRoute;
  support: number;
  confidence: number;
  lift: number;
  sampleSize: number;
  computedAt: string;
}

/**
 * 화면에 보여 줄 다리 전체.
 *
 * 확인 경로로 거르지 않고 다 돌려준다. 담당자가 "왜 이 원인은 시험 목록에 없는가"를
 * 물을 수 있어야 하고, 그 답이 화면에 함께 있어야 한다.
 */
export async function loadBridge(): Promise<BridgeRow[]> {
  const rows = await getDb()<{
    dt_code: string; dt_name: string | null; hf_code: string; hf_name: string | null;
    route: CauseRoute; support: string; confidence: string; lift: string;
    sample_size: string; computed_at: string;
  }[]>`
    select
      b.dt_code, d.name_ko dt_name, b.hf_code, h.name_ko hf_name, r.route,
      b.support::text, b.confidence::text, b.lift::text, b.sample_size::text,
      b.computed_at::text
    from codebook.cause_bridge b
    join codebook.hf_route r on r.code = b.hf_code
    left join codebook.hazard_factor h
      on h.code = b.hf_code
     and h.version_id = (select id from codebook.version where status = 'active')
    left join codebook.damage_type d
      on d.code = b.dt_code
     and d.version_id = (select id from codebook.version where status = 'active')
    order by b.sample_size desc, b.dt_code, b.confidence desc
  `;

  return rows.map((r) => ({
    dtCode: r.dt_code,
    dtName: r.dt_name,
    hfCode: r.hf_code,
    hfName: r.hf_name,
    route: r.route,
    support: Number(r.support),
    confidence: Number(r.confidence),
    lift: Number(r.lift),
    sampleSize: Number(r.sample_size),
    computedAt: r.computed_at,
  }));
}
