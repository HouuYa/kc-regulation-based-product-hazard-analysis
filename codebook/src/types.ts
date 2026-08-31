/**
 * 2차원 위해요인 분류 코드 — 타입 정의
 *
 * 출처: 제품_위해요인_분류체계_정립_PDR_v0_9_7.md
 * 설계: 01_사전분석_구현설계_v0.6.md §2.4 (코드북 독립 서비스)
 *
 * HF와 DT를 한 표에 담지 않는 이유(§2.4.4):
 *   두 축의 속성이 다르다. HF는 M-SHELL 계위·연계·리콜빈도를 갖고,
 *   DT는 ISO 5665 심각도 범위·PRISM 등급·EU Safety Gate 대응을 갖는다.
 *   PDR 부록 A도 hazard_factor_master / damage_type_master 로 분리한다.
 */

/** M-SHELL 대분류 (PDR §0.5) */
export type MshellLevel1 = 'H' | 'S' | 'M' | 'E' | 'L0' | 'L1' | 'UNKNOWN';

/** DT 중분류 그룹 (PDR §4.2) */
export type DtGroup =
  | 'THERMAL'
  | 'ELECTRIC'
  | 'MECHANICAL'
  | 'ASPHYX'
  | 'CHEMICAL'
  | 'BODY'
  | 'NON-PHYS'
  | 'OTHER';

/** 위해요인(원인) 코드 — HF.[대분류].[중분류].[소분류], 계위 가변 */
export interface HazardFactorCode {
  /** 예: HF.H.ELEC.NPC — PDR §4.2 최대 VARCHAR(30) */
  code: string;
  /** 2단계: H / S / M / E / L0 / L1 / UNKNOWN */
  mshell_level1: MshellLevel1;
  /** 3단계: ELEC / PHY / CHEM / SW / QC / DES ... (HF.UNKNOWN 은 null) */
  category_l2: string | null;
  /** 4단계: NPC / INS / OHT ... (3단 코드는 null) */
  category_l3: string | null;
  /** 계위 깊이 — HF.UNKNOWN=2, HF.M.DES=3, HF.H.ELEC.NPC=4 */
  depth: number;
  name_ko: string;
  name_en: string | null;
  definition: string | null;
  /** M-SHELL 연계 서술 (§5.2·5.3 표의 해당 열) */
  mshell_link: string | null;
  /** 해외 리콜 사례 / 사례 (§5.1 표의 해당 열) */
  example: string | null;
  /**
   * 리콜 통계에 빈번히 쓰이는가.
   * L0·L1 은 FALSE — 기본 드롭다운에 노출하지 않는다 (PDR 부록 A 비고, §0.4 정책)
   */
  is_recall_common: boolean;
  /** 이 코드를 정의한 PDR 절 (추적용) */
  source_section: string;
}

/** 피해유형(결과) 코드 — DT.[중분류].[소분류], 3단 고정 */
export interface DamageTypeCode {
  /** 예: DT.THERMAL.FIRE */
  code: string;
  dt_group: DtGroup;
  name_ko: string;
  name_en: string | null;
  definition: string | null;
  /** ISO 5665:2024 심각도 범위 — "3~5" → min 3, max 5 */
  severity_min: number | null;
  severity_max: number | null;
  /** PRISM v2.0 — Low / Medium / High / Serious (범위 표기 원문 그대로) */
  prism_risk_level: string | null;
  /** EU Safety Gate Type of Risk 대응 */
  eu_safetygate_type: string | null;
  source_section: string;
}

/**
 * 코드 조합 제약 (§2.4.4 "조합 제약이 명시돼 있는가")
 *
 * PDR §0.4·§4.4: L0·L1 코드는 단독 사용 금지 — 근본 원인이 제조자에 있음을
 * 명시하기 위해 HF.M.DES 또는 HF.M.QMS 와 반드시 병기한다.
 * resolve_code() 와 태깅 저장 단계가 이 표를 보고 검증한다.
 */
export interface CodeConstraint {
  /** 제약이 걸리는 코드 접두사 — 예: HF.L0 */
  subject_prefix: string;
  rule_type: 'REQUIRES_ANY_OF' | 'RECOMMENDS_ANY_OF';
  /** 이 중 최소 하나가 함께 있어야 한다 */
  requires_any_of: string[];
  reason: string;
  source_section: string;
}

/** AI 분류 학습용 키워드 (PDR 부록 G) — 키워드 갈래와 태깅 프롬프트의 씨앗 */
export interface CodeKeyword {
  axis: 'HF' | 'DT';
  code: string;
  keyword: string;
  keyword_group: string;
  source_section: string;
}

/** 파싱 1회의 산출물 전체 */
export interface CodebookParseResult {
  hazard_factors: HazardFactorCode[];
  damage_types: DamageTypeCode[];
  constraints: CodeConstraint[];
  keywords: CodeKeyword[];
  /** 파싱하지 못한 행 — 화면 B 에 목록으로 노출하고 직접 고친다 (§8.2) */
  failures: ParseFailure[];
}

export interface ParseFailure {
  section: string;
  line_no: number;
  raw: string;
  reason: string;
}
