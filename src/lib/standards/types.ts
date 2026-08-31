/**
 * KC안전기준 파싱 JSON → 조항 구조체 타입
 *
 * 입력은 협회가 준 OCR/계위 태거 결과물이다. 실물에서 확인한 구조:
 *   result.content.ocr.pages[]        페이지별 본문 HTML (bbox 포함)
 *   result.content.tagger.pages[]     페이지별 hierarchy[] — 조항번호·계위·본문
 *   result.content.caption.pages[]    그림 캡션
 *   result.content.dimension_ocr[]    치수 보정 결과
 *
 * 우리가 쓰는 것은 tagger.hierarchy 다. 나머지는 원본층에 그대로 둔다(§7.1).
 */

/** 파싱 JSON 의 최상위 (필요한 부분만 선언 — 나머지는 무시한다) */
export interface StandardResultJson {
  batch_id?: string;
  status?: string;
  filename?: string;
  total_pages?: number | string;
  result?: {
    filename?: string;
    content?: {
      ocr?: { pages?: OcrPage[]; confidence?: number | string };
      tagger?: { pages?: TaggerPage[]; model?: string };
    };
  };
}

export interface OcrPage {
  page_number: number;
  part_number: number | null;
  text: string;
}

export interface TaggerPage {
  page_number: number;
  hierarchy?: HierarchyItem[];
}

/**
 * 계위 태거가 뽑아 준 항목 하나.
 *
 * 주의: `title` 이 본문으로 흘러넘친 항목이 많다.
 * 예) 5.9.2 의 title 이 "5.9.1에 규정된 대로 의자를 조립하고 안정성 시험용 빔을 사용하여 의"
 * 그래서 title 을 신뢰하지 않고 marker + text 를 기준으로 삼는다.
 */
export interface HierarchyItem {
  marker?: string;
  title?: string;
  text?: string;
  /** 상위 조항번호 배열 — 예: ["4", "4.3"] */
  breadcrumb?: string[];
  /** 제1부 / 제2부 / 제3부. 부가 나뉜 기준이 있다 */
  part?: string | null;
  type?: string;
  /** L1~L7 / LF(그림) / LT(표) / LN(비고) */
  level_code?: string;
  level_name?: string;
  confidence?: number;
  /** 표 항목(LT)의 <table> HTML */
  caption?: string;
  bbox?: string;
}

/** 인증 구분 — 파일명에서 읽는다 */
export type CertScheme =
  | '안전인증'
  | '안전확인'
  | '공급자적합성'
  | '안전기준준수'
  | '전기용품' // KC 60335 계열 등 번호로만 된 기준
  | '미상';

export interface StandardMeta {
  source_filename: string;
  /** 파일 내용 해시 — 같은 파일 재적재 판별 */
  source_sha256: string;
  cert_scheme: CertScheme;
  /** 부속서 번호. 공통안전기준처럼 없는 경우 null */
  annex_no: string | null;
  /** 품목명 — 예: 유아용 의자 */
  item_name: string | null;
  /** 기준 번호 — 예: KC 60335-2-13 */
  standard_no: string | null;
  /** 화면·머리말에 쓰는 표시명 */
  display_name: string;
  total_pages: number | null;
  parser_model: string | null;
  ocr_confidence: number | null;
}

export interface ParsedClause {
  /** 조항번호 — 예: 4.3.3 */
  marker: string;
  part: string | null;
  /** 계위 경로 — 예: "제1부 > 4 > 4.3 > 4.3.3" */
  breadcrumb_path: string;
  level_code: string | null;
  level_name: string | null;
  clause_type: string | null;
  /** 태거가 준 title 원문. 오염된 경우가 많아 참고용으로만 둔다 */
  title_raw: string | null;
  body: string;
  page_no: number | null;
  parse_confidence: number | null;
  /** 문서 내 등장 순서 — 트리 정렬에 쓴다 */
  order_index: number;
  /**
   * 이 조항에 딸린 표의 원본 HTML.
   * 표 항목(LT)은 hierarchy 에서 marker 가 없어 독립 조항이 되지 못하므로,
   * 직전 조항에 붙여 둔다. 시험조건은 여기서 뽑는다.
   */
  tables: string[];
}

/**
 * 조항 간 참조 — 성능요건 ↔ 시험방법 연결 (설계문서 결정항목 1)
 *
 * 설계문서는 "파싱 데이터에 이 관계가 이미 있는지가 큰 분기점"이라 했는데,
 * 실물에는 전용 필드가 없는 대신 두 곳에 사실상 들어 있다.
 *   TABLE — 표의 "시험방법" 열이 조항번호를 직접 지목한다 (유해 원소 용출 → 5.4.1)
 *   TEXT  — 본문에 "5.9.2 및 5.9.3에 따른 시험 시" 형태로 명시된다
 */
export interface ParsedClauseLink {
  from_marker: string;
  to_marker: string;
  from_part: string | null;
  link_source: 'TABLE' | 'TEXT';
  /** 성능요건→시험방법인지, 단순 상호참조인지 */
  link_type: 'TEST_METHOD' | 'REFERENCE';
  /** 그 판단의 근거가 된 원문 구절 */
  evidence_span: string;
  /**
   * 참조 대상이 같은 기준 안에 실재하는가.
   *
   * false 인 경우가 실제로 많다. KC 60335-2-x 계열은 제1부(KC 60335-1)를 고쳐 쓰는
   * 부분 표준이라 "19.4에 명시한 내용에 따라" 같은 참조가 다른 기준을 가리킨다.
   * 버리지 않고 남겨 두어야 기준 간 연결을 나중에 이을 수 있다.
   */
  resolved: boolean;
}

/** 표에서 뽑은 시험조건 한 줄 (컨셉 5.1 의 핵심 산출 항목) */
export interface ParsedTestCondition {
  /** 이 표가 달린 조항 */
  clause_marker: string;
  part: string | null;
  /** 항목명 — 예: 안티모니 (Sb) */
  item_name: string;
  /** 상위 항목 — 예: 유해 원소 용출 */
  item_group: string | null;
  /** 허용치 원문 — 예: 60 mg/kg 이하 */
  allowance_raw: string | null;
  /** 수치만 분리 — 예: 60 */
  value_num: number | null;
  /** 단위 — 예: mg/kg */
  unit: string | null;
  /** 시험방법 조항 — 예: 5.4.1 */
  test_method_marker: string | null;
  source: 'TABLE';
}

export interface ParsedStandard {
  meta: StandardMeta;
  clauses: ParsedClause[];
  links: ParsedClauseLink[];
  test_conditions: ParsedTestCondition[];
  warnings: string[];
}
