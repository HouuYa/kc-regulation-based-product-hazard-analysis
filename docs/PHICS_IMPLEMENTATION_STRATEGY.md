# PHICS 분류체계 구현 전략

> **Version**: 1.0
> **Date**: 2026-03-10
> **Status**: 설계 완료, 구현 대기
> **Source PDR**: `리콜_원인_분류체계_정립_PDR_v0.9.3_최적화.pdf`
> **Related**: [`docs/SYSTEM_SPEC.md`](./SYSTEM_SPEC.md) (시스템 기준 문서)

---

## 1. 개요

### 1.1 목적

PDR v0.9.3에서 정의한 **PHICS(Product Hazard Information Classification System)** 이중 코드 분류체계를 Recall Hub의 n8n 워크플로우에 통합하고, 지식 표현 방식(RAG/Ontology/KAG)을 결정하는 전략 문서.

### 1.2 핵심 문제

현행 `hazard_type` 단일 필드는 **원인**(위해요인)과 **결과**(피해유형)를 혼용하여 단일 값으로 기록.
예: "화재위험"이라고만 기록하면 "배터리 결함이 몇 건?"이라는 통계 질문에 답할 수 없음.

### 1.3 해결: HF + DT 이중 코드

| 차원 | 코드 예시 | 핵심 질문 | 구조 | 코드 수 |
|-----|---------|---------|------|--------|
| **HF** (Hazard Factor, 위해요인) | `HF.H.ELEC.BAT` | "제품의 어떤 요소가 위험을 유발했는가?" | 4단계 계층 (M-SHELL 6요소) | ~30개 |
| **DT** (Damage Type, 피해유형) | `DT.THERMAL.FIRE` | "소비자에게 어떤 피해가 발생했는가?" | 3단계 계층 (8개 중분류) | 16개 |

**입출력:**
- 입력: `hazard_description` + `product_description` + `hazard_type` (현재 자유 텍스트)
- 출력: `hazard_factor_code` (1개 필수) + `hazard_factor_sub[]` + `damage_type_codes[]` + `iso5665_severity` (0~5) + `confidence`

---

## 2. 분류체계 요약

### 2.1 HF 코드 — M-SHELL 6요소 대분류

| 대분류 코드 | M-SHELL 요소 | 한국어 | 리콜 비중 |
|-----------|------------|-------|---------|
| `HF.H` | Hardware | 하드웨어 결함 | 가장 높음 |
| `HF.S` | Software/Standards | 절차/기준 위반 | 높음 |
| `HF.M` | Management | 관리 시스템 결함 | 중간 |
| `HF.E` | Environment | 환경 요인 | 낮음 |
| `HF.L0` | Liveware-self | 사용자 본인 오용 | 매우 낮음 |
| `HF.L1` | Liveware-other | 주변 관련자 결함 | 매우 낮음 |
| `HF.UNKNOWN` | — | 원인 미확인 | — |

**주요 중분류 (HF.H 하위):**
- `HF.H.ELEC` — 전기적 위해 (NPC, INS, OHT, BAT, SCORCH)
- `HF.H.PHY` — 물리적 위해 (SMALL, CORD, FRAC, SHARP, MAG, WATER)
- `HF.H.CHEM` — 화학적 위해 (LEAD, PHTH, FORM, FRAG, HEAVY, SCCP, ETC)
- `HF.H.SW` — 소프트웨어/펌웨어 위해 (ALGO, FW, UPDATE) — v0.9 신규

**주요 중분류 (HF.S 하위):**
- `HF.S.QC`, `HF.S.PROC`, `HF.S.INTL.ABS/DEF`, `HF.S.NATL.ABS/DEF`, `HF.S.CORP.ABS/DEF`, `HF.S.INFO`, `HF.S.ALGO`

**주요 중분류 (HF.M 하위):**
- `HF.M.DES`, `HF.M.QMS`, `HF.M.REG.ILLEGAL`, `HF.M.REG.UNMANAGED`, `HF.M.VIOL`

### 2.2 DT 코드 — 8개 중분류 그룹

| 중분류 | 코드 | 한국어 | ISO 5665 심각도 |
|------|------|-------|-------------|
| THERMAL | `DT.THERMAL.FIRE` | 화재/폭발 | 4~5 |
| | `DT.THERMAL.BURN` | 화상 | 2~4 |
| ELECTRIC | `DT.ELECTRIC.SHOCK` | 감전 | 3~4 |
| MECHANICAL | `DT.MECHANICAL.INJ` | 기계적 상해 | 2~3 |
| | `DT.MECHANICAL.FALL` | 낙상/전도 | 1~3 |
| ASPHYX | `DT.ASPHYX.CHOKE` | 질식/삼킴 | 3~5 |
| | `DT.ASPHYX.STRANG` | 목 조임 | 3~5 |
| | `DT.ASPHYX.DROWN` | 익사 | 4~5 |
| CHEMICAL | `DT.CHEMICAL.POISON` | 중독/유해물질 노출 | 2~4 |
| | `DT.CHEMICAL.ENV` | 환경 피해 | 0~2 |
| BODY | `DT.BODY.DEATH` | 사망 | 5 |
| | `DT.BODY.SENSE` | 청각/시각 손상 | 1~3 |
| NON-PHYS | `DT.NON-PHYS.PSYCH` | 심리적 피해 | 1~3 |
| | `DT.NON-PHYS.ECON` | 경제적 피해 | 0~1 |
| | `DT.NON-PHYS.PROP` | 재산 피해 | 0~2 |
| OTHER | `DT.OTHER.NEARMI` | 아차사고 | 0~1 |

### 2.3 분류 원칙

- **주된 위해요인(HF)**: 1개 필수 입력
- **부차 위해요인(HF_sub)**: 복수 입력 허용 (배열)
- **피해유형(DT)**: 복수 입력 허용 (배열, 최소 1개)
- **M-SHELL 우선순위**: H > S > M > E > L0/L1 (L0/L1은 단독 사용 금지, 반드시 HF.M 병기)
- **심각도**: 실제 피해 + 최악 시나리오 원칙 (ISO 12100:2010 "합리적으로 예견 가능한 최고 심각도")
- **EU Safety Gate 매핑**: Type of Risk 11개 → DT 코드 전항목 매핑 완비 (§6.4)

### 2.4 심각도 6단계 (ISO 5665 + METI + EU 2019/417 통합)

| Score | 한국어 | 정의 | PRISM Risk Level |
|-------|-------|------|-----------------|
| 5 | 사망 | 사고로 인한 즉사 또는 치료 중 사망 | Serious |
| 4 | 치명적 | 생명 유지에 위협, 영구적 장애 | Serious / High |
| 3 | 중증 | 24시간+ 입원 치료 필요 | High |
| 2 | 보통 | 응급실/외래 진료 필요, 6개월 미만 완치 | Medium |
| 1 | 경미 | 일상생활 큰 지장 없음, 자가 처치 가능 | Low |
| 0 | 무시가능 | 의료적 처치 불필요 | Low |

---

## 3. n8n 구현 전략 분석

### 3.1 현행 워크플로우 구조

```
현행 (13개 워크플로우 공통):
Trigger → Fetch → Dedup → AI Agent(추출+번역) → Upsert → Media Upload
                              │
                              ├─ LangChain Agent (gpt-5-mini primary, Gemini fallback)
                              ├─ Structured Output Parser (JSON 스키마)
                              └─ Auto-fixing Output Parser
```

- `hazard_type`을 자유 텍스트로 추출 중
- 별도 분류 노드 없음
- 모든 분류 로직이 AI Agent 프롬프트에 내장

### 3.2 구현 옵션 비교

| 옵션 | 설명 | 비용 효율 | 정확도 | 유지보수 | 추천 |
|------|------|---------|--------|---------|------|
| **A: 프롬프트 확장** | 기존 AI Agent에 HF/DT 코드사전 추가 | 나쁨 (토큰 2~3x) | 낮음 (환각 리스크) | 나쁨 (13곳 수정) | 비추천 |
| **B: 분류 서브워크플로우 (AI only)** | 별도 LLM 호출 | 보통 | 보통 | 좋음 (1곳 관리) | 보통 |
| **C: 하이브리드 (키워드+LLM)** | 규칙 1차 → LLM 2차 | 좋음 | 높음 | 좋음 | **추천** |
| **D: n8n Text Classifier** | 내장 분류 노드 | — | — | — | 부적합 (단일 레이블) |

### 3.3 추천: 옵션 C — 2단계 하이브리드 서브워크플로우

PDR 부록 E(n8n 연계)·G(AI 키워드 사전)·H(환각 통제)가 명시적으로 의도한 설계.

```
[Recall-Classification 서브워크플로우]

메인 워크플로우:
  Trigger → Fetch → Dedup → AI Agent(추출+번역)
    → [Recall-Classification 호출] → Upsert(분류 결과 포함) → Media

서브워크플로우 내부:
  1. Execute Workflow Trigger
     (입력: hazard_description, hazard_type, product_name, product_category, source)
     │
  2. Code Node: "Keyword Matcher" (Stage 1)
     │  ├─ 부록 G.1 HF 키워드 매칭
     │  ├─ 부록 G.2 DT 키워드 매칭
     │  ├─ 부록 G.3 복합 키워드 규칙
     │  ├─ EU Safety Gate Type of Risk → DT 직접 매핑 (§6.4)
     │  └─ confidence 산출
     │
  3. If Node: "confidence >= 0.7?"
     │
     ├─ TRUE → 4a. Code Node: "Format Output" (LLM 스킵)
     │
     └─ FALSE → 4b. AI Agent (LangChain)
                     ├─ 후보 코드 2~3개 + 정의만 프롬프트에 주입
                     ├─ Structured Output Parser
                     ├─ Auto-fixing Output Parser
                     └─ OpenAI primary + Gemini fallback
     │
  5. Code Node: "Validation"
     │  ├─ HF 코드 형식 검증 (HF.[H|S|M|E|L0|L1|UNKNOWN].*)
     │  ├─ DT 코드 형식 검증 (DT.[GROUP].[TYPE])
     │  ├─ L0/L1 단독 사용 금지 규칙
     │  ├─ DT 배열 최소 1개 규칙
     │  ├─ 심각도 범위 검증
     │  └─ 실패 시 → HF.UNKNOWN + DT.OTHER.NEARMI 폴백
     │
  6. Return Output
```

**Stage 1 — 키워드 매칭 엔진 (Code Node)**

부록 G 사전 기반 JavaScript 구현:

```javascript
// HF 키워드 → 코드 매핑 (부록 G.1)
const HF_KEYWORDS = {
  'HF.H.ELEC':       ['폭발', '터짐', '연기', '발화', '충전', '과열', '합선', '스파크'],
  'HF.H.ELEC.BAT':   ['배터리', '리튬', '전해액', '팽창', '충전기'],
  'HF.H.ELEC.OHT':   ['뜨거움', '녹음', '변형', '탄화'],
  'HF.H.ELEC.INS':   ['감전', '전기', '누전', '절연', '피복'],
  'HF.H.CHEM':       ['납', '프탈레이트', '냄새', '피부발진', '포름알데히드', '중금속'],
  'HF.H.PHY.SMALL':  ['삼킴', '소형부품', '자석', '단추'],
  'HF.H.PHY.CORD':   ['끈', '코드', '목', '줄림', '매달림'],
  'HF.H.PHY.FRAC':   ['깨짐', '파편', '날카로움', '모서리', '파손'],
  'HF.M.DES':        ['설계', '구조', '강도', '안정성', '전도'],
  'HF.M.REG.ILLEGAL':['미인증', '무허가', '불법', 'KC없음', '미확인'],
  'HF.H.SW':         ['오작동', '펌웨어', '업데이트', '센서', 'AI', '알고리즘'],
};

// DT 키워드 → 코드 매핑 (부록 G.2)
const DT_KEYWORDS = {
  'DT.THERMAL.FIRE':    ['불', '화재', '폭발', '연소', '발화', '착화'],
  'DT.THERMAL.BURN':    ['화상', '데임', '물집', '열상(열)'],
  'DT.ELECTRIC.SHOCK':  ['감전', '전기', '쇼크', '찌릿'],
  'DT.ASPHYX.CHOKE':    ['삼킴', '질식', '기도', '호흡곤란'],
  'DT.ASPHYX.STRANG':   ['목', '줄림', '교액', '매달림'],
  'DT.CHEMICAL.POISON': ['중독', '구토', '두통', '피부반응', '알레르기'],
  'DT.MECHANICAL.INJ':  ['베임', '찔림', '끼임', '골절', '타박'],
  'DT.MECHANICAL.FALL': ['넘어짐', '전도', '떨어짐', '추락'],
  'DT.BODY.DEATH':      ['사망', '숨짐'],
};
```

복합 키워드 규칙 (부록 G.3):
```
규칙 1: "폭발" + "화상" → HF.H.ELEC + DT.THERMAL.FIRE(Primary) + DT.THERMAL.BURN(Secondary)
규칙 2: "배터리" + "연기" + "그을음" → HF.H.ELEC.BAT + DT.THERMAL.FIRE
규칙 3: "자석" + "삼킴" + "복통" → HF.H.PHY.MAG + DT.ASPHYX.CHOKE(Primary) + DT.MECHANICAL.INJ(Secondary)
규칙 4: "미인증" + "감전" → HF.M.REG.ILLEGAL(Primary) + HF.H.ELEC.INS(Sub) + DT.ELECTRIC.SHOCK
```

신뢰도 산출 (부록 G 기준):
- 키워드 매칭만: 0.6~0.7
- LLM 추론 포함: 0.7~0.9
- 0.8 미만: 담당자 필수 확인 대상

**Stage 2 — AI Agent (낮은 신뢰도 건만)**

후보 코드 2~3개 + 정의만 주입하여 토큰 절약 + 환각 감소:

```
당신은 제품안전 전문가입니다. 아래 리콜 정보를 분석하여 HF/DT 코드를 분류하세요.

[후보 코드 — 이 중에서만 선택]
- HF.H.ELEC.OHT: 과열 설계 결함 (방열 설계 부족, 열관리 시스템 부재)
- HF.H.ELEC.BAT: 배터리 결함 (배터리 셀 품질 불량, 전해액 누출)
- HF.M.DES: 설계결함 (안전기준 미충족 설계)

[리콜 정보]
제품: {{ product_name }}
위해설명: {{ hazard_description }}
위해유형(원문): {{ hazard_type }}

반드시 아래 JSON 형식으로만 응답:
{
  "hazard_factor_code": "HF.H.ELEC.BAT",
  "hazard_factor_sub": ["HF.M.DES"],
  "damage_type_codes": ["DT.THERMAL.FIRE", "DT.THERMAL.BURN"],
  "damage_type_primary": "DT.THERMAL.FIRE",
  "iso5665_severity": 4,
  "reasoning": "배터리 셀 결함으로 인한 과열 발화, 최악 시나리오 주거 화재 가능",
  "confidence": 0.85
}
```

### 3.4 메인 워크플로우 변경사항

**Upsert body에 추가할 필드:**

```json
{
  "...기존 필드...",
  "hazard_factor_code": "{{ $json.hf_code }}",
  "hazard_factor_sub": "{{ $json.hf_sub }}",
  "damage_type_codes": "{{ $json.dt_codes }}",
  "damage_type_primary": "{{ $json.dt_primary }}",
  "iso5665_severity": "{{ $json.severity }}",
  "ai_confidence": "{{ $json.confidence }}",
  "ai_reasoning": "{{ $json.reasoning }}"
}
```

**13개 워크플로우 각각의 수정:**
- Upsert 직전에 서브워크플로우 호출 노드 1개 추가
- Upsert body에 분류 결과 필드 추가
- 기존 노드는 변경 없음

---

## 4. 지식 표현 방식 분석: RAG vs Ontology vs KAG

### 4.1 RAG (Retrieval-Augmented Generation)

```
[동작] 질의 → 벡터 검색 → 유사 문서 K개 → LLM 컨텍스트 주입 → 분류
```

**이 분류체계에 RAG가 부적합한 이유:**

| 판단 기준 | 적합성 | 이유 |
|----------|--------|------|
| 지식 규모 | 부적합 | 전체 코드 사전 HF 30개 + DT 16개 = ~5,000 토큰. 프롬프트에 전부 들어감 |
| 지식 변동성 | 부적합 | 코드 체계는 거버넌스 절차 거쳐 변경 (부록 H.1). 실시간 검색 불필요 |
| 검색 정확도 | 위험 | 벡터 유사도로 `HF.H.ELEC.BAT` vs `HF.H.ELEC.OHT` 구분 어려움 |
| 구조적 관계 | 부적합 | M-SHELL 우선순위, HF→DT 매핑, 심각도 범위 등 규칙 기반 관계를 벡터로 표현 불가 |

**RAG가 유용한 유일한 시나리오:**
과거 분류 이력에서 유사 사례 검색 (few-shot examples). 1,000건+ 축적 후 보조 수단으로만 가치 있음.

**결론: 주 분류 엔진으로 부적합. Phase 3에서 few-shot retrieval 보조 수단으로만 도입.**

### 4.2 Ontology (온톨로지)

```
[동작] 정형 개념·관계·규칙 체계 → 추론 엔진 → 분류
```

**이 분류체계는 본질적으로 이미 온톨로지:**

```
                    PHICS Ontology
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    HF Taxonomy    DT Taxonomy    Rules/Constraints
          │              │              │
    M-SHELL 6요소   8개 중분류      ├─ M-SHELL 우선순위
    → 30 leaf codes  → 16 codes    ├─ L0/L1 병기 규칙
          │              │         ├─ HF→DT 유효 매핑
          └──────┬───────┘         ├─ 심각도 범위
                 │                 └─ 최악 시나리오 원칙
           Cross-Mappings
           ├─ EU Safety Gate Type of Risk → DT
           ├─ PRISM Risk Level → Severity
           └─ OECD GPC → Product Category
```

**Full OWL vs Lightweight Ontology 비교:**

| 비교 | Full Ontology (OWL/Protege) | Lightweight (PostgreSQL) |
|------|---------------------------|------------------------|
| 표현력 | 매우 높음 (OWL-DL 추론) | 충분함 (FK, CHECK, 트리거) |
| 쿼리 | SPARQL | SQL (익숙, 빠름) |
| n8n 연동 | 별도 API 서버 필요 | HTTP Request로 직접 |
| 인프라 | Apache Jena/Fuseki 추가 | 기존 Supabase 활용 |
| 유지보수 | 온톨로지 전문가 필요 | DBA로 충분 |

PDR 부록 A가 이미 Lightweight Ontology를 제시:
- `hazard_factor_master` = HF 분류 체계
- `damage_type_master` = DT 분류 체계
- `legacy_hazard_mapping` = 기존 데이터 마이그레이션
- FK + CHECK + 트리거 = 추론 규칙

**결론: 개념적으로 정답. PostgreSQL 마스터 테이블로 "Lightweight Ontology" 구현. Full OWL 불필요.**

### 4.3 KAG (Knowledge Augmented Generation)

```
[동작] Knowledge Graph + LLM
       ├─ 지식 그래프에서 구조적 정보 검색
       ├─ 관계 추론 (graph traversal)
       └─ LLM이 그래프 컨텍스트로 분류
```

**KAG가 풀 수 있는 질문:**
- "배터리 결함(HF.H.ELEC.BAT) → 화재(DT.THERMAL.FIRE)" 패턴에서 가장 많이 동반되는 부차 HF 코드는?
- EU Safety Gate에서 동일 패턴의 Risk Level 분포는?

| 장점 | 단점 |
|------|------|
| 구조적 추론 가능 | 가장 복잡한 구현 |
| 관계 기반 검색 → 높은 정확도 | Neo4j 등 추가 인프라 |
| 새 코드 추가 시 노드만 추가 | n8n 직접 연동 어려움 |
| 감사 추적 우수 | 현재 46개 코드에는 과잉 |

**결론: 장기적으로 가장 강력. 현재 단계 시기상조. 1,000건+ 분류 이력 축적 후 Phase 3에서 도입.**

### 4.4 의사결정 매트릭스 요약

| 접근법 | 현재(Phase 1) | 중기(Phase 2) | 장기(Phase 3) |
|--------|:-----------:|:-----------:|:-----------:|
| **Keyword + Prompt Engineering** | **채택** | 유지 | 유지 (Stage 1) |
| **Lightweight Ontology (PostgreSQL)** | — | **채택** | 유지 |
| **RAG (few-shot retrieval)** | — | — | **보조 도입** |
| **KAG (Knowledge Graph + LLM)** | — | — | **검토** |
| Full OWL Ontology | 불필요 | 불필요 | 불필요 |

---

## 5. DB 스키마 변경 계획

PDR 부록 A 기준. `SYSTEM_SPEC.md`의 기존 스키마 위에 추가.

### 5.1 마스터 테이블 (Phase 2에서 구축)

```sql
-- 위해요인 마스터 테이블
CREATE TABLE hazard_factor_master (
    code              VARCHAR(30) PRIMARY KEY,  -- 예: HF.H.ELEC.NPC
    mshell_level1     VARCHAR(5) NOT NULL,      -- H / S / M / E / L0 / L1 / UNKNOWN
    category_l2       VARCHAR(10),              -- ELEC / PHY / CHEM 등
    category_l3       VARCHAR(10),              -- NPC / INS / OHT 등 소분류
    name_ko           VARCHAR(100) NOT NULL,
    name_en           VARCHAR(100),
    eu_safetygate_risk VARCHAR(50),
    prism_hazard_type VARCHAR(50),
    is_recall_common  BOOLEAN DEFAULT TRUE,     -- L0/L1은 FALSE
    description       TEXT,
    is_active         BOOLEAN DEFAULT TRUE,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- 피해유형 마스터 테이블
CREATE TABLE damage_type_master (
    code               VARCHAR(30) PRIMARY KEY,  -- 예: DT.THERMAL.FIRE
    dt_group           VARCHAR(15) NOT NULL,      -- 중분류 그룹
    name_ko            VARCHAR(100) NOT NULL,
    name_en            VARCHAR(100),
    iso5665_severity_min INTEGER,                 -- 최소 심각도 (0~5)
    iso5665_severity_max INTEGER,                 -- 최대 심각도 (0~5)
    prism_risk_level   VARCHAR(10),               -- Low / Medium / High / Serious
    eu_safetygate_type VARCHAR(50),
    gpsr_harm_category VARCHAR(50),
    description        TEXT,
    is_active          BOOLEAN DEFAULT TRUE,
    created_at         TIMESTAMPTZ DEFAULT NOW()
);
```

### 5.2 recalls 테이블 확장 (Phase 1에서 즉시 가능)

```sql
ALTER TABLE recalls
  ADD COLUMN hazard_factor_code   VARCHAR(30),
  ADD COLUMN hazard_factor_sub    TEXT[] DEFAULT '{}',
  ADD COLUMN damage_type_codes    TEXT[] DEFAULT '{}',
  ADD COLUMN damage_type_primary  VARCHAR(30),
  ADD COLUMN iso5665_severity     INTEGER,
  ADD COLUMN ai_confidence        NUMERIC(4,3),
  ADD COLUMN ai_reasoning         TEXT;

-- 인덱스
CREATE INDEX idx_recalls_hf_code ON recalls(hazard_factor_code);
CREATE INDEX idx_recalls_dt_codes ON recalls USING GIN(damage_type_codes);
CREATE INDEX idx_recalls_dt_primary ON recalls(damage_type_primary);
CREATE INDEX idx_recalls_severity ON recalls(iso5665_severity);
```

### 5.3 레거시 매핑 테이블

기존 `hazard_type` 자유 텍스트 → HF/DT 코드 마이그레이션:

```sql
CREATE TABLE legacy_hazard_mapping (
    legacy_value       VARCHAR(100) PRIMARY KEY,  -- 기존 값 (예: '감전위험')
    hazard_factor_code VARCHAR(30),               -- HF 코드
    damage_type_codes  TEXT[],                    -- DT 코드 배열
    confidence         VARCHAR(10),               -- HIGH / MEDIUM / LOW
    notes              TEXT
);
```

레거시 매핑 예시 (부록 A.3):

| 기존 값 | HF 코드 | DT 코드 | 신뢰도 |
|--------|---------|---------|--------|
| 감전위험 | HF.H.ELEC.INS | ['DT.ELECTRIC.SHOCK'] | HIGH |
| 화재위험 | HF.H.ELEC.OHT | ['DT.THERMAL.FIRE'] | HIGH |
| 화상위험 | HF.H.ELEC.OHT | ['DT.THERMAL.BURN'] | MEDIUM |
| 유해물질 | HF.H.CHEM.ETC | ['DT.CHEMICAL.POISON'] | MEDIUM |
| 질식위험 | HF.H.PHY.SMALL | ['DT.ASPHYX.CHOKE'] | HIGH |
| 파손/파편 | HF.H.PHY.FRAC | ['DT.MECHANICAL.INJ'] | HIGH |
| 목 조임 | HF.H.PHY.CORD | ['DT.ASPHYX.STRANG'] | HIGH |
| 환경오염 | HF.H.CHEM.SCCP | ['DT.CHEMICAL.ENV'] | MEDIUM |

---

## 6. EU Safety Gate → DT 코드 자동 매핑

PDR §6.4 기준. EU Safety Gate Type of Risk는 DT 코드로 직접 매핑 가능:

| EU Safety Gate Type of Risk | DT 코드 |
|----------------------------|---------|
| Chemical | `DT.CHEMICAL.POISON` |
| Injuries | `DT.MECHANICAL.INJ`, `DT.MECHANICAL.FALL`, `DT.BODY.DEATH` |
| Environmental | `DT.CHEMICAL.ENV` |
| Electric Shock | `DT.ELECTRIC.SHOCK` |
| Choking | `DT.ASPHYX.CHOKE` |
| Fire | `DT.THERMAL.FIRE`, `DT.THERMAL.BURN` |
| Strangulation | `DT.ASPHYX.STRANG` |
| Drowning | `DT.ASPHYX.DROWN` |
| Damage to hearing/sight | `DT.BODY.SENSE` |
| Property damage | `DT.NON-PHYS.PROP` |
| Energy resources | `DT.CHEMICAL.ENV` (에너지 규정 위반) |

이 매핑은 Stage 1 키워드 매칭에서 소스가 EU일 때 직접 적용 가능 → 높은 신뢰도.

---

## 7. 실제 리콜 사례 적용 예시

PDR §7.2 기준, 실제 해외 리콜에 HF/DT 이중 코드 적용:

| 리콜 사례 | M-SHELL 분석 | HF 코드 | DT 코드 | 출처 |
|---------|------------|---------|---------|------|
| 자석 물풍선 (영국) | H: 소형자석, L: 어린이 | `HF.H.PHY.SMALL`, `HF.H.PHY.MAG` | `DT.ASPHYX.CHOKE` | EU Safety Gate |
| 보조배터리 과열 (프랑스) | H: 열관리 결함, M: 설계검토 누락 | `HF.H.ELEC.OHT`, `HF.M.DES` | `DT.THERMAL.FIRE`, `DT.THERMAL.BURN` | EU Safety Gate |
| 전기청소기 절연 불량 (영국) | H: 절연 결함, S: 안전기준 미준수 | `HF.H.ELEC.INS`, `HF.S.STD` | `DT.ELECTRIC.SHOCK` | EU Safety Gate |
| 유아복 끈 (캐나다) | H: 끈 구조, M: 안전 설계기준 미적용 | `HF.H.PHY.CORD`, `HF.M.DES` | `DT.ASPHYX.STRANG` | OECD |
| 리튬배터리 팽창 (호주) | H: 배터리 셀 불량, S: 품질검수 미비 | `HF.H.ELEC.BAT`, `HF.S.QC` | `DT.THERMAL.FIRE` | OECD |

---

## 8. 구현 로드맵

### Phase 1: n8n 하이브리드 분류 (즉시 착수, ~4주)

- [ ] `recalls` 테이블에 분류 컬럼 추가 (ALTER TABLE)
- [ ] Recall-Classification 서브워크플로우 생성
  - [ ] Stage 1: 키워드 매칭 Code Node (부록 G 사전)
  - [ ] Stage 2: AI Agent (후보 코드 기반 분류)
  - [ ] Validation Code Node
- [ ] 13개 메인 워크플로우에 서브워크플로우 호출 추가
- [ ] Upsert body에 분류 결과 필드 추가
- [ ] EU Safety Gate 소스: Type of Risk → DT 직접 매핑 (고신뢰)
- [ ] 기존 데이터 레거시 매핑 배치 실행

### Phase 2: DB Ontology 정착 (4~8주 후)

- [ ] `hazard_factor_master` 마스터 테이블 생성 (30개 코드)
- [ ] `damage_type_master` 마스터 테이블 생성 (16개 코드)
- [ ] `legacy_hazard_mapping` 매핑 테이블 생성 + 데이터
- [ ] FK 제약조건 추가 (마스터 → recalls)
- [ ] `calc_final_severity` 트리거 함수 (부록 A)
- [ ] `check_hf_code_active` 트리거 (deprecated 코드 차단)
- [ ] PRISM Risk Level 자동 산출 모듈
- [ ] AI 추천 → 담당자 승인 워크플로우 (부록 H.2)

### Phase 3: KAG 진화 (6개월+, 1,000건+ 축적 후)

- [ ] 과거 분류 이력 기반 few-shot retrieval (RAG 보조)
- [ ] 그래프 기반 HF↔DT 교차 분석
- [ ] 자동 승인 임계값 캘리브레이션
- [ ] OECD GlobalRecalls API + EU Safety Gate 자동 매핑 고도화
- [ ] 통계 대시보드 (M-SHELL 분포, 원인-결과 히트맵, 시계열 트렌드)

---

## 9. 통계 활용 쿼리 예시

HF/DT 이중 코드 도입 후 가능해지는 교차 분석 (PDR §7.3):

### 예시 1: 배터리 결함 리콜 중 화재 비율

```sql
SELECT
  COUNT(*) FILTER (WHERE 'DT.THERMAL.FIRE' = ANY(damage_type_codes)) AS fire_count,
  COUNT(*) AS total_bat,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE 'DT.THERMAL.FIRE' = ANY(damage_type_codes)) / COUNT(*), 1
  ) AS fire_pct
FROM recalls
WHERE hazard_factor_code = 'HF.H.ELEC.BAT';
```

### 예시 2: 화재 사고의 원인 분포

```sql
SELECT
  hazard_factor_code,
  COUNT(*) AS cnt
FROM recalls
WHERE 'DT.THERMAL.FIRE' = ANY(damage_type_codes)
GROUP BY hazard_factor_code
ORDER BY cnt DESC;
```

### 예시 3: M-SHELL 대분류별 리콜 빈도

```sql
SELECT
  split_part(hazard_factor_code, '.', 2) AS mshell_level1,
  COUNT(*) AS cnt
FROM recalls
WHERE hazard_factor_code IS NOT NULL
GROUP BY mshell_level1
ORDER BY cnt DESC;
```

---

## 10. 참조

| 문서 | 용도 |
|------|------|
| PDR v0.9.3 (`리콜_원인_분류체계_정립_PDR_v0.9.3_최적화.pdf`) | 분류체계 원본 정의서 |
| PDR §5 | HF 코드 전체 목록 + 정의 |
| PDR §6 | DT 코드 전체 목록 + 심각도 |
| PDR §7 | 코드 적용 방법 + 실사례 |
| PDR 부록 A | DB 스키마 변경 방안 (규범적) |
| PDR 부록 B | HF/DT 전체 코드 목록 (대분류별 그룹) |
| PDR 부록 E | n8n 워크플로우 연계 방안 |
| PDR 부록 G | AI 분류 학습용 키워드 사전 |
| PDR 부록 H | 개발/운영 실무 고려사항 (거버넌스, 환각 통제, DB 제약) |
| PDR 부록 I | 국제 표준 연계 및 리스크평가 |
| [`docs/SYSTEM_SPEC.md`](./SYSTEM_SPEC.md) | 시스템 기준 문서 |
| ISO 5665:2024 | M-SHELL 모델, Severity 0~5 |
| ISO 12100:2010 | 합리적 예견 가능한 오용 |
| EU 2019/417 (RAPEX Guidelines) | 리콜 조치 8단계, 위험 구분 |
| PRISM v2.0 (UK OPSS, 2024) | Risk 4단계 체계 |
| CENELEC Guide 32:2014 | 위해요인 기원(origin)/성질(nature) 분류 |

---

_이 문서는 PDR v0.9.3 분석 결과를 기반으로 한 구현 전략 문서입니다.
분류체계의 공식 정의는 PDR 원본을 참조하세요._
