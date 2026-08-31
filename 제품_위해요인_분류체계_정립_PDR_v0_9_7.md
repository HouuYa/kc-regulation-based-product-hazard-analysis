---
tags:
  - PDR
  - M-SHELL
  - ISO5665
  - 제품위해정보분류시스템
  - OECD-GlobalRecalls
  - EU-SafetyGate
  - GPSR2024
  - PRISM
  - ISO12100
  - 제품위해분류체계
created: 2026-02-23
updated: 2026-04-27
version: v0.9.7
description: 리콜 원인 분류 체계 정립을 위한 계획서 — 제품위해정보분류시스템 적용 범위 한정, ISO/KS 규격 문서 형식
참고문서: "[[(세부과제 4) 제품사고조사 정보관리 체계 개선 계획(안)v0.3.pdf|내부 추진 계획 보고]]"
---


**문서 번호**: PDR-2026-001
**버전**: v0.9.7         |
| §1  | 목적 및 적용 범위                   |
| §2  | 인용 표준                        |
| §3  | 용어 정의                        |
| §4  | 분류 원칙                        |
| §5  | HF 위해요인(Hazard Factor) 코드 체계 |
| §6  | DT 피해유형(Damage Type) 코드 체계   |
| §7  | 코드 적용 방법                     |

| 부록 | 제목 | 구분 |
|---|---|:---:|
| 부록 A | DB 스키마 변경 방안 | 규범적 |
| 부록 B | 사고조사 대장 엑셀 적용 예시 | 참고 |
| 부록 C | 참조 문서 및 출처 | 참고 |
| 부록 D | 개발 로드맵 | 참고 |
| 부록 E | n8n 워크플로우 연계 방안 | 참고 |
| 부록 F | OECD GPC 기반 제품 카테고리 연계 방안 | 참고 |
| 부록 G | AI 분류 학습용 키워드 사전 | 참고 |
| 부록 H | 개발·운영 단계 실무 고려사항 | 참고 |
| 부록 I | 국제 표준 연계 및 리스크평가 | 참고 |
| 부록 J | 변경 이력 | 참고 |

<div style="page-break-before: always;"></div>

## §0. 요약 — 한 눈에 보는 계획안

> **[안내]** 이 페이지는 기술 배경 없이도 개선 방향을 파악할 수 있도록 작성하였습니다.

### 0.1 현황 → 문제 → 해결 흐름

```

┌────────────────────────────────────────────────────────────────────────────┐
│  현황 (As-Is)          핵심 문제               개선안 (To-Be)                │
│                                                                            │
│  리콜통계 ──┐          3개 시스템이            HF + DT                       │
│             ├──→ [위해유형 단일필드] ──→   서로 다른 언어 ──→  2차원 코드 체계 │
│  사고조사 ──┤     원인·결과 혼재          사용 → 연계 불가          +         │
│             │     국제연계 불가                              M-SHELL 6요소   │
│  리스크평가 ┘                                                국제표준 정합   │
└────────────────────────────────────────────────────────────────────────────┘

```

**비유**: 지금은 교통사고 기록에 "충돌"이라고만 적는 것과 같습니다. 개선 후에는 "브레이크 결함(원인)으로 인한 차량 파손(결과)"처럼 원인과 결과를 분리하여 기록합니다. 이렇게 해야 "브레이크 결함이 몇 건?"이라는 통계 질문에 답할 수 있습니다.

---

### 0.2 HF와 DT — 왜 두 코드가 모두 필요한가

**HF (Hazard Factor, 위해요인)** 와 **DT (Damage Type, 피해유형)** 는 사고를 바라보는 두 가지 시각입니다.

| 코드 | 영문 Full Name | 한국어 | 역할 | 핵심 질문 |
|:---:|---|:---:|:---:|---|
| **HF** | **Hazard Factor** | 위해요인 | 사고 **원인** | "제품의 어떤 요소가 위험을 유발했는가?" |
| **DT** | **Damage Type** | 피해유형 | 사고 **결과** | "소비자에게 어떤 피해가 발생했는가?" |

**왜 둘 다 필요한가**: 같은 원인이 다른 결과를, 같은 결과가 다른 원인에서 비롯될 수 있기 때문입니다.

```

같은 원인(HF) → 다른 결과(DT):
  HF.H.ELEC.BAT (배터리 결함)
  ├─→ DT.THERMAL.FIRE (화재)  : 충전 중 발화
  └─→ DT.THERMAL.BURN (화상)  : 배터리 폭발 시 피부 접촉

같은 결과(DT) → 다른 원인(HF):
  DT.ASPHYX.CHOKE (질식·삼킴)
  ├─ HF.H.PHY.SMALL : 소형 부품 삼킴
  └─ HF.H.PHY.CORD  : 끈이 목을 조름
  
```

> **[예시]** 병원 진료 기록에 "골절(결과)"만 기록하면 낙상인지 교통사고인지 알 수 없습니다. "낙상으로 인한 골절 예방"을 위해서는 원인(낙상)과 결과(골절)를 분리해야 합니다. HF(원인)와 DT(결과)도 같은 이치입니다.

**단일 코드로 답할 수 없는 질문들** (HF·DT 분리 후 가능):
- "배터리 결함(`HF.H.ELEC.BAT`) 리콜 중 화재(`DT.THERMAL.FIRE`)는 몇 %인가?"
- "화재(`DT.THERMAL.FIRE`) 사고의 원인 중 설계 결함(`HF.M.DES`)은 몇 건인가?"
- "어린이 완구 리콜에서 가장 많이 발생하는 피해 유형은?"

---

### 0.3 코드 체계 구조 — 주소처럼 읽으세요

**HF 코드(위해요인)**: 컴퓨터 폴더 경로처럼 단계별로 범위를 좁혀 들어갑니다.

```
HF  .  H  .  ELEC  .  NPC
 ↑      ↑      ↑        ↑
위해   대분류  중분류    소분류
요인  (누구의  (어떤    (구체적
코드   잘못?)  영역?)   원인?)
```

**읽는 법 예시**: `HF.H.ELEC.NPC` = "위해요인(HF) 중에서, 하드웨어 결함(H) 중에서, 전기(ELEC) 문제 중에서, 보호회로가 없는 것(NPC)"

**DT 코드(피해유형)** : 역시 점(.)으로 중분류를 거쳐 소분류로 좁혀 들어갑니다.

```
DT  .  THERMAL  .  FIRE
 ↑       ↑          ↑
피해    중분류      소분류
유형  (어떤 종류의  (구체적
코드   피해?)      피해?)
```

**읽는 법 예시**: `DT.THERMAL.FIRE` = "피해유형(DT) 중에서, 열적 피해(THERMAL) 중에서, 화재(FIRE)"

---

### 0.4 L0·L1 코드 — 왜 코드 체계에 있는가

**Liveware(생체인간)란**: 1970년대 항공 안전 연구에서 탄생한 신조어입니다. 컴퓨터에 Hardware(기계)·Software(프로그램)가 있듯, 시스템에서 가장 복잡하고 유연한 요소인 **사람(인간)을 Liveware**라 부릅니다. M-SHELL 모델의 L은 두 종류입니다.

| 코드 | 영문 Full Name | 한국어 | 항공 비유 | 리콜에서의 의미 |
|:---:|---|:---:|:---:|---|
| **HF.L0** | Liveware-**self** (중심 인물) | 사용자 본인 | 조종사 | 제품을 직접 사용하는 소비자 본인 |
| **HF.L1** | Liveware-**other** (주변 인물) | 주변 관련자 | 관제사·승무원 | 사용자 주변 보호자·판매자·유통자 |

**리콜에서 L0·L1이 드문 이유**: 리콜의 본질적 원인은 **제품 결함**입니다. 소비자 행동(L0·L1)이 사고에 기여하더라도, ISO 12100:2010은 제조자가 **"합리적으로 예견 가능한 오용(reasonably foreseeable misuse)"을 설계 단계에서 반드시 고려**해야 한다고 규정합니다.

**그럼에도 코드를 유지하는 이유**: 사용자 행동이 계기가 된 사례를 기록할 공간이 있어야 하며, 이 경우 **반드시 HF.M.DES(설계결함) 또는 HF.M.QMS(품질관리체계 결함)와 함께 기록**하여 근본 원인이 제조자에 있음을 명시합니다.

```
⚠ L0·L1 코드는 단독 사용 금지 — 반드시 병기:
  HF.L0.CHILD  (어린이 오용)   → HF.M.DES  병기 필수
  HF.L1.RETAIL (판매자 결함)   → HF.M.QMS  병기 필수
  이유: "사용자 행동은 계기, 근본 원인은 설계·관리 결함"
```

> **[정책]** 사고 담당자가 코드를 입력할 때, L0·L1 코드는 기본 선택 목록에 표시되지 않습니다. 리콜 원인의 대부분이 제품 결함(HF.H·HF.S·HF.M)이므로, 담당자가 실수로 L0·L1만 단독 입력하는 오류를 방지하기 위해서입니다. L0·L1 코드 사용이 필요한 경우, 해당 항목을 별도로 활성화하고 선임 담당자가 병기 요건(HF.M.DES 또는 HF.M.QMS) 충족 여부를 확인한 후 입력합니다.

---

### 0.5 HF 코드 약어 사전 — 대분류 요약

> **[참조]** 중분류·소분류 전체 목록은 **§5(HF 코드 체계)** 및 **§6(DT 코드 체계)** 참조


#### 대분류: M-SHELL 6요소 (ISO 5665:2024 기반)

|  대분류 코드   |       M-SHELL 요소       | 한국어 뜻 | 쉬운 설명               |  리콜에서의 비중   |
| :-------: | :--------------------: | :---: | ------------------- | :---------: |
| **HF.H**  |      H = Hardware      | 하드웨어  | 제품 자체·부품·재료·내장SW의 결함 | ★★★★★ 가장 높음 |
| **HF.S**  | S = Software/Standards | 절차·기준 | 안전기준 부재·미흡, 공정 절차 위반 |   ★★★★ 높음   |
| **HF.M**  |     M = Management     |  관리   | 설계·품질관리·인증 체계 결함    |   ★★★ 중간    |
| **HF.E**  |    E = Environment     |  환경   | 보관·사용 환경(온도·습도)이 원인 |    ★★ 낮음    |
| **HF.L0** |  L = Liveware (self)   |  사용자  | 소비자 본인의 오용·부주의      |  ★ 매우 낮음 ※  |
| **HF.L1** |  L = Liveware (other)  |  관련자  | 보호자·판매자의 관리 부실      |  ★ 매우 낮음 ※  |

> **[비고]** 리콜은 제품 결함이 원인이므로 L0·L1은 드물지만, ISO 12100:2010이 "합리적으로 예견 가능한 오용"을 설계자가 반드시 고려하도록 규정하고 있어 코드 체계에 유지합니다.

---

### 0.6 DT 코드 약어 사전 (전체 16개, 8개 중분류 그룹)

| 중분류 | 코드 | 약어 원문 | 한국어 | EU Safety Gate 대응 | ISO 5665 심각도 |
|:---:|:---:|---|:---:|:---:|:---:|
| **THERMAL** | **DT.THERMAL.FIRE** | Fire | 화재·폭발 | Fire | 4~5 |
| | **DT.THERMAL.BURN** | Burn | 화상 | Fire (thermal) | 2~4 |
| **ELECTRIC** | **DT.ELECTRIC.SHOCK** | Electrical Shock | 감전 | Electric Shock | 3~4 |
| **MECHANICAL** | **DT.MECHANICAL.INJ** | Mechanical Injury | 기계적 상해 | Injuries | 2~3 |
| | **DT.MECHANICAL.FALL** | Fall | 낙상·전도 | Injuries (fall) | 1~3 |
| **ASPHYX** | **DT.ASPHYX.CHOKE** | Choking | 질식·삼킴 | Choking | 3~5 |
| | **DT.ASPHYX.STRANG** | Strangulation | 목 조임 | Strangulation | 3~5 |
| | **DT.ASPHYX.DROWN** | Drowning | 익사 | Drowning | 4~5 |
| **CHEMICAL** | **DT.CHEMICAL.POISON** | Poisoning | 중독·유해물질 노출 | Chemical | 2~4 |
| | **DT.CHEMICAL.ENV** | Environmental | 환경 피해 | Environmental | 0~2 |
| **BODY** | **DT.BODY.DEATH** | Death | 사망 | Injuries (Fatal) | 5 |
| | **DT.BODY.SENSE** | Sensory damage | 청각·시각 손상 | Damage to hearing/sight | 1~3 |
| **NON-PHYS** | **DT.NON-PHYS.PSYCH** | Psychological harm | 심리적 피해 | — (PRISM 2024 반영) | 1~3 |
| | **DT.NON-PHYS.ECON** | Economic loss | 경제적 피해 | — (GPSR 2024 반영) | 0~1 |
| | **DT.NON-PHYS.PROP** | Property damage | 재산 피해 | Property damage | 0~2 |
| **OTHER** | **DT.OTHER.NEARMI** | Near Miss | 아차사고 | — | 0~1 |

> **[참조]** 0=아차사고(Negligible) · 1=경미(Slight) · 2=중등도(Moderate) · 3=중증(Serious) · 4=치명(Fatal) · 5=사망(Death). 단계별 상세 정의는 §6.2.1 참조.


---

### 0.7 3개 통계 시스템 연계 구조

```
┌──────────────┐    HF 코드    ┌──────────────┐    DT 코드    ┌──────────────┐
│  리콜 통계   │◄────────────►│  사고조사    │◄────────────►│ 리스크평가   │
│              │              │  대장        │              │  (위해도 DB) │
│              │              │              │              │              │
│• 위해요인별  │              │• M-SHELL 원인│              │• Severity    │
│  리콜 빈도   │              │  분석        │              │  (0~5)       │
│• 제품군별    │              │• HF+DT       │              │• Probability │
│  트렌드      │              │  이중 분류   │              │• Risk Level  │
└──────────────┘              └──────────────┘              └──────────────┘
         ▲                            ▲                            ▲
         └────────────────────────────┼────────────────────────────┘
                              공통 코드 체계
                        HF.X.XXX.XXX + DT.GROUP.CODE

         ▲ OECD GlobalRecalls API (46개국) + EU Safety Gate 자동 매핑
```

---
<div style="page-break-before: always;"></div>

## §1. 목적 및 적용 범위

### 1.1 목적

본 문서는 제품위해정보분류시스템에 적용할 리콜 원인 분류 체계를 정립하고, 이를 리콜 통계·사고조사 대장·리스크평가 세 시스템에 공통으로 적용하기 위한 코드 체계와 운용 규칙을 규정한다.

세부 목적:
- 현행 `위해유형` 단일 필드를 **위해요인(HF)** + **피해유형(DT)** 이중 코드 체계로 전환
- ISO 5665:2024 M-SHELL 6요소를 HF 코드 대분류로 채택하여 국제 표준 정합성 확보
- OECD GlobalRecalls(46개국) 및 EU Safety Gate와의 자동 매핑 구조 마련

### 1.2 적용 범위

본 문서에서 정의한 분류 코드 체계는 다음에 적용한다.

- 제품위해정보분류시스템 `hazard_factor_master` 및 `damage_type_master` 마스터 테이블
- 제품위해정보분류시스템 `incidents` 테이블의 위해요인 및 피해유형 입력 필드
- 사고조사 대장 엑셀 양식의 신규 컬럼 (부록 B 참조)
- 리콜 통계 보고서의 원인 분류 기준

### 1.3 현행 분류 체계의 한계

- **단일 필드의 정보 손실 문제**: 현재 `위해유형` 컬럼은 "감전위험", "화재위험" 등 **결과(피해)** 와 **원인(위해요인)** 을 혼용하여 단일 값으로 기록. 원인과 결과를 구분할 수 없어 통계 분석 불가.
- **3개 통계 시스템의 분류 언어 불일치**: 리콜 통계, 제품사고 조사대장, 리스크평가 세 시스템이 각각 다른 분류 언어 사용. OECD GlobalRecalls와 EU Safety Gate의 이중 필드 구조와 연계 불가.
- **ISO 5665:2024 M-SHELL 모델과의 정합성 부재**: 국제 표준 M-SHELL 6요소 구조와 현행 단순 분류가 호환되지 않음.

---

## §2. 인용 표준 및 법규

| 구분        | 문서                                                          | 적용 조항                                                       |
| --------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| 국제 표준     | **ISO 5665:2024** Consumer incident investigation           | M-SHELL 모델(Annex A.4), Severity 0~5 척도(§3.5)                |
| 국제 표준     | **ISO 12100:2010** Safety of machinery — Risk assessment    | 합리적으로 예견 가능한 오용 개념(§3.24)                                   |
| EU 규범     | **EU GPSR (EU) 2023/988** General Product Safety Regulation | 피해 정의 확장(신체→심리·경제·환경), 2024-12-13 발효                        |
| EU 규범     | **EU 2019/417** RAPEX Guidelines                            | 리콜 조치 8단계 계층, 심각/경미 위험 구분 기준                                |
| EU 규범     | **Commission Implementing Regulation (EU) 2024/3173**       | Safety Gate 운영 및 위험 평가 방법론                                  |
| EU 기술 가이드 | **CENELEC Guide 32:2014**                                   | 위해요인 기원(origin)·성질(nature) 이축 분류                            |
| 영국 정부     | **PRISM v2.0 (UK OPSS, 2024)**                              | Risk 4단계(Low/Medium/High/Serious), 심리·경제 피해 포함              |
| 일본 정부     | **METI リスクアセスメント・ハンドブック (2011)**                            | 심각도 5단계(Fatal/Serious/Moderate/Slight/Negligible), 리스크평가 실무 |
| 네덜란드      | **RIVM Toy Risk Assessment (2008)**                         | 화학물질 노출경로 6가지, 연령별 노출 특성                                    |

---

<div style="page-break-before: always;"></div>

## §3. 용어 및 정의

이 문서에서 사용하는 주요 용어는 다음과 같이 정의한다.

**3.1 위해요인 (Hazard Factor, HF)**
사고 발생의 원인이 되는 제품·환경·인간 요소. ISO 5665:2024 §3.4에 따라 "소비자 제품의 위해에 기여하는 요인(factor contributing to a hazard in a consumer product)"으로 정의. 본 문서에서 `HF.` 점 표기 코드로 분류한다.

**3.2 피해유형 (Damage Type, DT)**
사고로 소비자에게 발생한 실제 결과. ISO 5665:2024 §3.5에 따라 "사고의 결과로 소비자가 입은 피해의 유형(type of harm suffered by consumer as a consequence of an incident)"으로 정의. 본 문서에서 `DT.` 점(.) 계층 표기 코드로 분류한다.

**3.3 M-SHELL 모델**
항공 분야 SHELL 모델에 Management(관리) 요소를 추가한 사고 원인 분석 도구. ISO 5665:2024 Annex A.4에 채택. 구성 요소: M(관리), S(절차/기준), H(하드웨어), E(환경), L0(사용자-중심), L1(관련자-주변). (약어 M-SHELL 순서 기준; §0.5 표는 리콜 비중 높은 순으로 재배열)

**3.4 Liveware**
1970년대 Elwyn Edwards가 SHELL 모델에서 제안한 신조어. Hardware(기계)·Software(프로그램)에 대응하여 시스템 내 **인간 요소**를 지칭. L0(사고의 직접 당사자-조종사 역할)과 L1(주변 관련자-관제사 역할)으로 구분.

**3.5 합리적으로 예견 가능한 오용 (Reasonably Foreseeable Misuse)**
ISO 12100:2010 §3.24. 제조자가 설계 단계에서 반드시 고려해야 하는 소비자의 비의도적 오용 패턴. L0·L1 코드 유지의 이론적 근거.

**3.6 리스크 (Risk)**
ISO 5665:2024 기반. Risk = Severity(심각도) × Probability(발생확률). Severity는 DT 코드 기반 0~5 척도, Probability는 제품 출하량·노출 인구 기반으로 산출.

**3.7 제품위해정보분류시스템 (PHICS)**
국내외 리콜제품정보, 제품사고 정보, 위해도 정보를 위해요인(HF)과 피해유형(DT) 이중 코드 체계로 분류·관리하는 시스템. 영문 약어 **PHICS**(Product Hazard Information Classification System) 표기 가능. 본 문서에서는 전문(全文) '제품위해정보분류시스템'을 원칙으로 하며, UI 레이블·코드 주석에서는 'PHICS' 약어 사용을 허용한다.

---

<div style="page-break-before: always;"></div>

## §4. 분류 원칙

### 4.1 이중 코드 분류 원칙

현행 단일 `위해유형` 필드를 **위해요인(HF)** + **피해유형(DT)** 두 차원으로 분리한다.

```
[사고] ─→ 위해요인(HF.) : "왜" 위험했는가 (M-SHELL 6요소 대분류)
         ↓
       피해유형(DT.) : "어떤" 피해가 발생했는가 (복수 가능)
```

**학술적 근거**: CENELEC Guide 32는 위해요인을 **기원(origin)** 과 **성질(nature)** 두 축으로 분류. "전기 위해요인(electrical hazard)"은 기원이고, "감전(electric shock)"은 그 결과. 이것이 HF(원인)와 DT(결과)를 분리하는 국제 표준 근거. OECD GlobalRecalls와 EU Safety Gate도 동일하게 이중 필드로 운용.

### 4.2 코드 표기 규칙

| 구분 | 표기 방식 | 예시 | 최대 길이 |
|---|:---:|---|:---:|
| 위해요인 (HF) | 점(.) 계층 구분 | `HF.H.ELEC.NPC` | VARCHAR(30) |
| 피해유형 (DT) | 점(.) 계층 구분 | `DT.THERMAL.FIRE` | VARCHAR(30) |

**HF 코드 계층 구조**:
```
HF . [대분류] . [중분류] . [소분류]
  1단계        2단계       3단계     4단계
```
- 1단계: `HF` (위해요인 코드 식별자)
- 2단계: M-SHELL 대분류 (H/S/M/E/L0/L1/UNKNOWN)
- 3단계: 중분류 (ELEC/PHY/CHEM/SW/QC/PROC/INTL/NATL/CORP/INFO/ALGO/DES/QMS/REG/VIOL/THERM/MOIST/USE/CHILD/MISUSE/ELDERLY/DISABLED/GUARD/MFR/IMP/AGENT/DIST/RETAIL)
- 4단계: 소분류 (NPC/INS/OHT/BAT/SCORCH/ALGO 등)

**DT 코드 계층 구조**:
```
DT . [중분류] . [소분류]
 1단계      2단계      3단계
```
- 1단계: `DT` (피해유형 코드 식별자)
- 2단계: 중분류 그룹 (THERMAL/ELECTRIC/MECHANICAL/ASPHYX/CHEMICAL/BODY/NON-PHYS/OTHER)
- 3단계: 소분류 (FIRE/BURN/SHOCK/INJ/FALL/CHOKE/STRANG/DROWN/POISON/ENV/DEATH/SENSE/PSYCH/ECON/PROP/NEARMI)

> **[비고]** 기존 `DT-FIRE` 하이픈 코드는 `legacy_dt_mapping` 테이블에 매핑을 유지한다. 마이그레이션 기간 동안 두 코드를 병행 인식하되, 신규 입력은 반드시 `DT.` 점 표기를 사용한다.

### 4.3 복수 코드 입력 원칙

- **주된 위해요인(hazard_factor_code)**: 1개 필수 입력
- **부차 위해요인(hazard_factor_sub)**: 복수 입력 허용 (배열, 예: `['HF.H.ELEC.OHT', 'HF.M.DES']`)
- **피해유형(damage_type_codes)**: 복수 입력 허용 (배열, 예: `['DT.THERMAL.FIRE', 'DT.THERMAL.BURN']`)

### 4.4 M-SHELL 대분류 입력 우선순위 기준

하나의 사고에서 복수의 M-SHELL 요인이 확인될 때, 주된 위해요인은 다음 우선순위로 선정한다.

```
1순위: HF.H (하드웨어 결함) — 물리적 제품 결함이 직접 원인인 경우
2순위: HF.S (절차·기준 위반) — 기준 미준수·공정 절차 위반이 주된 원인인 경우
3순위: HF.M (관리 결함) — 설계·품질관리 체계 결함이 주된 원인인 경우
4순위: HF.E (환경 요인) — 사용·보관 환경이 직접 원인이고 제품 결함이 없는 경우
5순위: HF.L0/L1 (사용자/관련자) — 반드시 HF.M 병기, 단독 사용 금지
마지막: HF.UNKNOWN — 조사 진행 중 또는 원인 미특정 시
```

---

<div style="page-break-before: always;"></div>

## §5. 위해요인 코드 체계 (HF)

### 5.1 HF.H — 하드웨어 위해요인

*M-SHELL H(Hardware) 요소 — 제품 자체, 부품, 재료의 물리적·전기적·화학적 결함*

#### 5.1.1 HF.H.ELEC — 전기적 위해

| 코드                 | 한국어명      | 정의                              | 해외 리콜 사례                    |
| ------------------ | --------- | ------------------------------- | --------------------------- |
| `HF.H.ELEC.NPC`    | 보호회로 부재   | 과전류·과충전 방지 회로 없거나 오작동           | 일본 RecallPlus: 리튬이온 배터리 과충전 |
| `HF.H.ELEC.INS`    | 절연 불량     | 전선·부품 간 절연 결함으로 누전·감전           | 영국 OPSS: 전기청소기 케이블 절연 결함    |
| `HF.H.ELEC.OHT`    | 과열 설계 결함  | 방열 설계 부족, 열관리 시스템 부재            | 프랑스 RappelConso: 보조배터리 과열   |
| `HF.H.ELEC.BAT`    | 배터리 결함    | 배터리 셀 품질 불량, 전해액 누출             | 호주 ACCC: 리튬배터리 팽창           |
| `HF.H.ELEC.SCORCH` | 비화재 열적 사고 | 그을음, 탄화, 스파크 등 화재에 이르지 않은 열적 손상 | 일본 NITE: 그을음·스파크 사고 보고      |

#### 5.1.2 HF.H.PHY — 물리적 위해

| 코드 | 한국어명 | 정의 | 해외 리콜 사례 |
|---|---|---|---|
| `HF.H.PHY.SMALL` | 소형 부품 | 어린이 삼킴·흡입 위험의 소형 부품 포함 | EU Safety Gate: 완구 소형 부품 (2024 상위 5위) |
| `HF.H.PHY.CORD` | 코드/끈 위험 | 어린이 목 조임 위험의 끈·코드류 | 캐나다: 유아복 끈 안전기준 미달 |
| `HF.H.PHY.FRAC` | 파손·파편 | 충격 시 날카로운 파편 생성 가능 | 독일 BAuA: 완구 파손 시 날카로운 파편 |
| `HF.H.PHY.SHARP` | 날카로운 엣지 | 제품 표면 날카로운 모서리·돌출부 | EU Safety Gate: 가구 날카로운 모서리 |
| `HF.H.PHY.MAG` | 강력 자석 | 고강도 자석 삼킴 시 장기 손상 | 영국·미국: 네오디뮴 자석 제품 리콜 다수 |
| `HF.H.PHY.WATER` | 방수·부력 결함 | 수상 제품의 부력·방수 설계 결함 | OECD: 어린이용 수영 보조 도구 안전 결함 |

#### 5.1.3 HF.H.CHEM — 화학적 위해

| 코드 | 한국어명 | 정의 | 해외 리콜 사례 |
|---|---|---|---|
| `HF.H.CHEM.LEAD` | 납 함유 | 안전기준 초과 납 검출 | CPSC: 어린이 장신구 납 초과 |
| `HF.H.CHEM.PHTH` | 프탈레이트 | 어린이제품 내 프탈레이트 기준 초과 | EU: 완구 플라스틱 프탈레이트 |
| `HF.H.CHEM.FORM` | 포름알데히드 | 포름알데히드 등 유해 VOC 기준 초과 | 중국 SAMR: 가구 포름알데히드 |
| `HF.H.CHEM.FRAG` | 유해 향료 | EU 금지 합성 향료 성분 초과 | EU Safety Gate 2024: BMHCA 화장품 |
| `HF.H.CHEM.HEAVY` | 중금속 (기타) | 카드뮴·니켈·납 등 장신구·완구 초과 | EU Safety Gate 2024: 장신구 카드뮴·니켈 |
| `HF.H.CHEM.SCCP` | 단쇄 염화파라핀 | SCCP 등 환경 잔류성 유해물질 | EU Safety Gate 2024: 전선 케이블 SCCP 검출 |
| `HF.H.CHEM.ETC` | 기타 유해물질 | PCB, 기타 제한 물질 초과 | EU RAPEX: 기타 제한 화학물질 |

#### 5.1.4 HF.H.SW — 소프트웨어/펌웨어 위해

*제품에 내장된 소프트웨어·펌웨어·알고리즘의 결함으로 인한 물리적 위해*

| 코드 | 한국어명 | 정의 | 사례 |
|---|---|---|---|
| `HF.H.SW.ALGO` | 알고리즘 오류 | 제품 내장 AI/알고리즘의 오작동·오판단으로 인한 물리적 위해 | 자율주행 센서 오인식, AI 의료기기 오진 |
| `HF.H.SW.FW` | 펌웨어 결함 | 제품 제어 펌웨어의 버그·업데이트 오류로 인한 위해 | IoT 기기 펌웨어 업데이트 후 과열 |
| `HF.H.SW.UPDATE` | 업데이트 후 결함 | OTA 업데이트·학습 이후 발생한 기능 이상 | 스마트 가전 업데이트 후 안전 기능 비활성화 |

> **[적용 기준]** HF.H.SW는 제품에 물리적으로 내장된 소프트웨어가 위해의 직접 원인인 경우에 사용. 안전 기준·절차 측면의 알고리즘 결함(예: AI 안전 검증 절차 부재)은 HF.S.ALGO를 사용한다. 알고리즘에 의한 **심리적·인지적 피해**는 DT.NON-PHYS.PSYCH 코드와 연결한다.

---

### 5.2 HF.S — 절차·기준 위해요인

*M-SHELL S(Software/절차) 요소 — 안전기준의 존재·충분성, 검수 절차, 제조 공정 절차, 알고리즘 안전 검증*


| 코드              | 한국어명          | 정의                                          | M-SHELL 연계         |
| --------------- | ------------- | ------------------------------------------- | ------------------ |
| `HF.S.QC`       | 품질검수 미비       | 부품·완제품 품질 검수 기준 미비                          | S: 부품 검수 절차 미준수    |
| `HF.S.PROC`     | 제조공정 절차 위반    | 생산 현장의 표준 작업 절차(SOP) 이탈, 조립 불량              | S: 제조 공정 표준 절차 미준수 |
| `HF.S.INTL.ABS` | 국제표준 부재       | 해당 제품에 적용 가능한 국제 표준(ISO, IEC 등)이 존재하지 않는 상태 | S: 참조 표준 자체 부존재    |
| `HF.S.INTL.DEF` | 국제표준 미흡       | 국제 표준이 존재하나 해당 위해를 충분히 커버하지 못하는 상태          | S: 참조 표준의 범위 불충분   |
| `HF.S.NATL.ABS` | 국내표준 부재       | 국내 안전기준(KC 인증 등)이 존재하지 않는 상태                | S: 국내 법적 기준 부존재    |
| `HF.S.NATL.DEF` | 국내표준 미흡       | 국내 안전기준이 존재하나 위해를 충분히 커버하지 못하는 상태           | S: 국내 법적 기준 불충분    |
| `HF.S.CORP.ABS` | 내부규정 부재       | 제조사 내부 안전 규정이 없는 상태                         | S: 조직 내부 절차 부재     |
| `HF.S.CORP.DEF` | 내부규정 미흡       | 내부 안전 규정이 존재하나 불충분한 상태                      | S: 조직 내부 절차 불충분    |
| `HF.S.INFO`     | 안전정보 부족       | 경고문, 사용설명서, 주의사항, 라벨 등 소비자 안전정보 부족          | S: 정보 제공 절차 미비     |
| `HF.S.ALGO`     | 알고리즘 안전 검증 미비 | AI·SW 안전성 검증 절차·기준이 부재하거나 미흡한 상태            | S: SW 안전 검증 절차 미비  |

> **[예시]** 건물 안전 점검에 비유하면, INTL.ABS는 "설계 기준 자체가 없는 것", NATL.DEF는 "기준은 있지만 내진 설계가 빠진 것", CORP.ABS는 "건물주가 자체 점검 규정을 아예 만들지 않은 것"이다.
>
> **[적용 기준]** HF.S.ALGO는 "AI 안전 검증 기준·절차가 없거나 미흡한 것"(기준의 문제), HF.H.SW.ALGO는 "제품에 탑재된 알고리즘 자체가 오작동한 것"(제품의 문제). 같은 AI 사고라도 원인이 기준 부재인지 알고리즘 결함인지에 따라 코드가 달라진다.

---

### 5.3 HF.M — 관리시스템 위해요인

*M-SHELL M(Management) 요소 — 제조사의 안전관리 시스템, 설계 검토 체계, 법적 인증 관리 결함*


| 코드                   | 한국어명            | 정의                                      | M-SHELL 연계          |
| -------------------- | --------------- | --------------------------------------- | ------------------- |
| `HF.M.DES`           | 설계결함            | 안전기준 미충족 설계(불량)                         | M: 설계 안전검토 프로세스 부재  |
| `HF.M.QMS`           | 품질관리체계 결함       | 품질관리 시스템(QMS) 전반의 체계 부재                 | M: 조직 안전문화·QMS 미흡   |
| `HF.M.REG.ILLEGAL`   | 법적 인증 고의 위반(불법) | 법적 인증 절차(KC 인증, CE 마킹 등)를 고의로 위반한 불법 제품 | M: 법적 인증 관리 고의 위반   |
| `HF.M.REG.UNMANAGED` | 비관리대상 제품        | 현행 안전관리 대상에 포함되지 않아 인증·관리가 이루어지지 않는 제품  | M: 관리 체계 적용 범위 밖    |
| `HF.M.VIOL`          | 내부규정 고의 위반      | 내부 안전 규정을 인지하면서도 고의로 위반                 | M: 조직 내 규정 준수 관리 실패 |

> **[비고]** `HF.M.DES` 정의에서 "구조적 취약점"을 삭제. 구조적 결함은 HF.H(하드웨어) 소분류에서 다루며, HF.M.DES는 설계 검토 프로세스의 관리적 결함에 초점을 둔다.
>
> **[적용 기준]** 비관리대상 제품은 "관리 시스템 자체가 해당 제품을 포괄하지 못한 것"(M)이면서, 동시에 "적용할 안전기준이 없는 상태"(S)이기도 하다. 따라서 `HF.M.REG.UNMANAGED`를 주된 코드로 기록하고, `HF.S.NATL.ABS` 또는 `HF.S.INTL.ABS`를 부차 코드로 병기하는 것을 권장한다.
>
> **[예시]** 불법제품(ILLEGAL)은 "운전면허 시험이 있는데 무면허 운전한 것"이고, 비관리대상(UNMANAGED)은 "그 탈것에 대한 면허 제도 자체가 없는 것"이다. 전자는 고의 위반, 후자는 제도적 공백이다.

---

### 5.4 HF.E — 환경 위해요인

*M-SHELL E(Environment) 요소 — 제품 사용·보관 환경이 위해의 직접 원인인 경우*

| 코드 | 한국어명 | 정의 | M-SHELL 연계 |
|---|---|---|---|
| `HF.E.THERM` | 온도·열 환경 | 고온 환경에서의 배터리 열폭주 등 온도 요인 | E: 사용 환경 온도 조건 |
| `HF.E.MOIST` | 습도·수분 환경 | 습기·침수로 인한 전기·재료 결함 촉발 | E: 환경 수분 조건 |
| `HF.E.USE` | 사용 환경 결함 | 협소 공간·과부하 환경에서의 제품 성능 저하 | E: 물리적 사용 환경 |

> **[주의]** HF.E 코드는 제품 자체에는 결함이 없으나 환경 요인이 위해를 유발한 경우에 한해 사용. 대부분의 리콜은 HF.H 또는 HF.S·HF.M 코드에 해당.

---

### 5.5 HF.L0 — 사용자 위해요인 (Liveware-self) ※맥락 유지

> **[비고]** 1970년대 영국 항공의학 연구자 Elwyn Edwards가 SHELL 모델에서 처음 제안한 신조어. 컴퓨터 시스템에서 Hardware(기계)·Software(프로그램)가 있듯, 시스템의 가장 복잡하고 예측하기 어려운 요소인 **인간(사람)을 Liveware**라 명명. **L0(Liveware-self)은 사고의 중심 당사자** — 항공기로 치면 **조종사** 역할.

*M-SHELL L(Liveware, 중심) 요소 — 소비자 본인의 행동이 위해의 직접 원인*

| 코드             | 한국어명   | 정의                      | M-SHELL 연계   |
| -------------- | ------ | ----------------------- | ------------ |
| `HF.L0.CHILD`  | 어린이 오용 | 연령 부적합 사용, 어린이의 예견가능 오용 | L: 사용자 행동 특성 |
| `HF.L0.MISUSE` | 일반소비자 오용 | 성인 일반소비자의 예견가능 비의도적 오용    | L: 사용자 행동 특성 |
| `HF.L0.ELDERLY` | 노약자 오용 | 고령자·체력 약화 소비자의 예견가능 오용 | L: 취약계층 사용자 행동 특성 |
| `HF.L0.DISABLED` | 장애인 오용 | 장애를 가진 소비자의 예견가능 오용 | L: 취약계층 사용자 행동 특성 |

> **[비고]** `HF.L0.MISUSE` 명칭을 "소비자 오용" → "일반소비자 오용"으로 변경하여 CHILD·ELDERLY·DISABLED와 명확히 구분. ELDERLY·DISABLED 코드는 PRISM v2.0이 "취약계층(vulnerable groups)"에 대한 별도 고려를 권장하는 점을 반영.
>
> **[적용 기준]** ISO 12100:2010 §3.24의 "합리적으로 예견 가능한 오용(reasonably foreseeable misuse)" 기준. 리콜 사례에서는 빈도가 낮으나, 이 경우 오용을 설계단계에서 고려하지 않은 제조자 책임이 동반되므로 HF.M.DES와 병기 권장. **코드 체계에 유지하되, 사용 시 조사 담당자 확인 필수**.

---

### 5.6 HF.L1 — 관련자 위해요인 (Liveware-other) ※맥락 유지

> **[비고]** L1(Liveware-other)은 사고의 주변 인물 — 항공기로 치면 관제사·승무원 역할. L0(사용자 본인)과 달리, L1은 사고 현장에 있지 않더라도 사고 발생에 간접적으로 영향을 미친 주변 관련자. 단, 이 경우에도 근본 원인은 제조자가 안전정보 전달 체계를 갖추지 않은 **HF.M.QMS**에 있음.

*M-SHELL L(Liveware, 주변) 요소 — 사용자 주변 관련자의 행동이 위해의 직접 원인*

#### 5.6.1 보호자

| 코드             | 한국어명      | 정의               | M-SHELL 연계   |
| -------------- | --------- | ---------------- | ------------ |
| `HF.L1.GUARD`  | 보호자 감독 소홀 | 어린이 제품 보호자 감독 부재 | L: 주변 관련자 행동 |

#### 5.6.2 공급망 관련자

| 코드             | 한국어명    | 정의                               | M-SHELL 연계   |
| -------------- | ------- | -------------------------------- | ------------ |
| `HF.L1.MFR`    | 제조사 결함  | OEM/ODM 제조사의 안전정보 미제공 또는 불량품 출하  | L: 제조 관련자 행동 |
| `HF.L1.IMP`    | 수입자 결함  | 수입자가 국내 안전기준 확인·적합성 확보를 이행하지 않음  | L: 수입 관련자 행동 |
| `HF.L1.AGENT`  | 구매대행 결함 | 구매대행업자가 미인증·비관리 제품을 중개           | L: 대행 관련자 행동 |
| `HF.L1.DIST`   | 유통사 결함  | 유통 과정 보관·운송 부적절, 안전정보 미전달        | L: 유통 관련자 행동 |
| `HF.L1.RETAIL` | 판매자 결함  | 최종 판매자의 안전정보 미제공, 리콜 대상 제품 계속 판매 | L: 판매 관련자 행동 |

> **[예시]** 해외 직구 보조배터리 사고 시: 중국 OEM 제조사가 KC 인증 없이 출하(HF.L1.MFR) → 구매대행업자가 인증 여부 확인 없이 중개(HF.L1.AGENT) → 실제 원인은 인증 체계 자체의 관리 결함(HF.M.REG.ILLEGAL)과 병기.
>
> **[적용 기준]** 리콜 특성상 빈도가 매우 낮음. 코드 체계에 유지하되, 사용 시 조사 담당자 확인 필수. L1 코드 선택 시 반드시 **어느 공급망 단계에서 안전 관리가 끊어졌는지**를 특정하여 기록한다.

---

### 5.7 HF.UNKNOWN — 미확인 위해요인

| 코드 | 한국어명 | 정의 |
|---|---|---|
| `HF.UNKNOWN` | 원인 미확인 | 조사 중이거나 원인 미특정 |

---
<div style="page-break-before: always;"></div>

## §6. 피해유형 코드 체계 (DT)

사고로 인해 소비자에게 실제 발생한 **결과**를 분류한다. ISO 5665:2024 Severity(0~5), EU Safety Gate Type of Risk 11개, PRISM v2.0(2024) 심리적 피해 확장, GPSR 2024 경제적 피해 확장을 통합 반영한다.

### 6.1 DT 코드 전체 목록 (중분류별)

전체 16개 코드를 8개 중분류 그룹으로 분류한다. 각 중분류의 상세 정의는 아래 소절 참조.

#### 6.1.1 DT.THERMAL — 열적 피해

| 코드 | 한국어명 | ISO 5665 심각도 | EU Safety Gate | PRISM Risk Level | 정의 |
|---|---|:---:|---|:---:|---|
| `DT.THERMAL.FIRE` | 화재/폭발 | 4~5 | Fire | Serious | 화재 발생, 폭발, 연소 피해 |
| `DT.THERMAL.BURN` | 화상 | 2~4 | Fire (thermal) | Medium~High | 열·화학·전기에 의한 화상 |

#### 6.1.2 DT.ELECTRIC — 전기적 피해

| 코드 | 한국어명 | ISO 5665 심각도 | EU Safety Gate | PRISM Risk Level | 정의 |
|---|---|:---:|---|:---:|---|
| `DT.ELECTRIC.SHOCK` | 감전 | 3~4 | Electric Shock | High~Serious | 전기 감전 사고 |

#### 6.1.3 DT.MECHANICAL — 기계적 피해

| 코드 | 한국어명 | ISO 5665 심각도 | EU Safety Gate | PRISM Risk Level | 정의 |
|---|---|:---:|---|:---:|---|
| `DT.MECHANICAL.INJ` | 기계적 상해 | 2~3 | Injuries | Medium | 베임, 찔림, 끼임, 파편에 의한 부상 |
| `DT.MECHANICAL.FALL` | 낙상/전도 | 1~3 | Injuries (fall) | Low~Medium | 제품 결함으로 인한 낙상, 전도 |

#### 6.1.4 DT.ASPHYX — 질식·조임

| 코드 | 한국어명 | ISO 5665 심각도 | EU Safety Gate | PRISM Risk Level | 정의 |
|---|---|:---:|---|:---:|---|
| `DT.ASPHYX.CHOKE` | 질식/삼킴 | 3~5 | Choking | High~Serious | 이물질 삼킴, 기도 막힘 |
| `DT.ASPHYX.STRANG` | 목 조임 | 3~5 | Strangulation | High~Serious | 끈·코드류 목 조임 |
| `DT.ASPHYX.DROWN` | 익사 | 4~5 | Drowning | Serious | 수상 제품 결함으로 인한 익사 |

#### 6.1.5 DT.CHEMICAL — 화학·중독

| 코드 | 한국어명 | ISO 5665 심각도 | EU Safety Gate | PRISM Risk Level | 정의 |
|---|---|:---:|---|:---:|---|
| `DT.CHEMICAL.POISON` | 중독/유해물질 노출 | 2~4 | Chemical | Medium~High | 유해화학물질 흡입·섭취·피부 접촉 |
| `DT.CHEMICAL.ENV` | 환경 피해 | 0~2 | Environmental | Low | RoHS 위반, 환경 오염 물질 방출 |

#### 6.1.6 DT.BODY — 인체 피해

| 코드 | 한국어명 | ISO 5665 심각도 | EU Safety Gate | PRISM Risk Level | 정의 |
|---|---|:---:|---|:---:|---|
| `DT.BODY.DEATH` | 사망 | 5 | Injuries (Fatal) | Serious | 사고로 인한 사망 |
| `DT.BODY.SENSE` | 청각·시각 손상 | 1~3 | Damage to hearing/sight | Low~Medium | 소음·과도한 빛에 의한 청각·시각 피해 |

#### 6.1.7 DT.NON-PHYS — 비신체 피해

| 코드 | 한국어명 | ISO 5665 심각도 | EU Safety Gate | PRISM Risk Level | 정의 |
|---|---|:---:|---|:---:|---|
| `DT.NON-PHYS.PSYCH` | 심리적 피해 | 1~3 | — (PRISM 2024) | Low~Medium | 정신적 충격, AI 알고리즘에 의한 인지적·심리적 조작 포함 |
| `DT.NON-PHYS.ECON` | 경제적 피해 | 0~1 | — (GPSR 2024) | Low | 신체 피해 없는 경제적 손실 |
| `DT.NON-PHYS.PROP` | 재산 피해 | 0~2 | Property damage | Low | 인명 피해 없는 재산 손실 |

#### 6.1.8 DT.OTHER — 기타

| 코드 | 한국어명 | ISO 5665 심각도 | EU Safety Gate | PRISM Risk Level | 정의 |
|---|---|:---:|---|:---:|---|
| `DT.OTHER.NEARMI` | 아차사고 | 0~1 | — | Low | 피해 발생 직전 중단된 사고 |

---

### 6.2 심각도 측정 기준

심각도(Severity)는 DT 코드에 기반하여 0~5의 6단계로 평가한다. ISO 5665:2024, METI 리스크 어세스먼트 핸드북(5단계), EU 2019/417(4단계)를 통합하여 아래와 같이 정의한다.

#### 6.2.1 심각도 6단계 정의 (ISO 5665 + METI + EU 2019/417 통합)


본 심각도 분류는 ISO 5665의 사고 조사 원칙과 EU 2019/417의 위해 평가 가이드를 결합하여, 제품 사고로 인한 인적 피해를 객관적으로 측정하기 위해 0~5단계로 구조화한 것입니다.

| 통합 단계 (Score) |  ISO 5665 대응<br>(조사기준)   | METI 대응 (R-Map)  | EU 2019/417 대응 |  한국어 명칭   | 정의 및 피해 정도                                                | 주요 의료 개입 기준                    |
| :-----------: | :----------------------: | :--------------: | :------------: | :-------: | :-------------------------------------------------------- | :----------------------------- |
|     **5**     | 중대한 위해<br>(Serious Harm) |   4단계 (Fatal)    |    Level 4     |  **사망**   | 사고로 인한 즉사 또는 치료 중 사망                                      | - (Exitus)                     |
|     **4**     | 중대한 위해<br>(Serious Harm) |   4단계 (Fatal)    |    Level 4     |  **치명적**  | 생명 유지에 위협이 되거나, 뇌사·사지 상실·신체 마비 등 영구적인 장애가 남는 경우           | 중환자실(ICU) 치료, 대수술              |
|     **3**     | 중대한 위해<br>(Serious Harm) |  3단계 (Serious)   |    Level 3     |  **중증**   | 24시간 이상의 입원 치료가 필요하며, 6개월 이상의 기능 장애 또는 영구적 기능 저하를 초래하는 경우 | 입원 치료 (심한 골절, 2도 이상의 광범위 화상 등) |
|     **2**     |       일반 위해 (Harm)       |  2단계 (Moderate)  |    Level 2     |  **보통**   | 응급실 또는 전문의 외래 진료가 필요하나 입원은 불필요한 경우. 기능 장애가 6개월 미만이며 완치 가능 | 응급실/외래 처치 (단순 골절, 심한 베임 등)     |
|     **1**     |       일반 위해 (Harm)       |   1단계 (Slight)   |    Level 1     |  **경미**   | 일상생활에 큰 지장이 없으며, 일차 의료기관(클리닉)의 통원 치료 또는 자가 처치가 가능한 수준     | 통원 치료, 일차 진료 (찰과상, 가벼운 화상 등)   |
|     **0**     |         무시 가능 수준         | 0단계 (Negligible) |       -        | **무시 가능** | 의료적 처치가 거의 필요 없거나 반창고 부착 등 단순 응급 처치만으로 충분한 경우             | 자가 처치 및 경과 관찰                  |

> **[참조 및 주의사항]**
> 1. **통합 적용:** EU 2019/417은 위해의 심각도를 4단계로 정의하며, 객관적인 의료 개입 수준을 주요 척도로 활용합니다.
> 2. **판정 우선순위:** 동일 사고에서 여러 부상이 발생한 경우, 가장 높은 심각도 단계를 해당 사고의 최종 심각도로 결정합니다.
> 3. **부위별 차등:** 구체적인 판정은 **부록 B(TBD)** 의 "건강피해 심각도 매트릭스"를 참조하십시오. 예를 들어, 동일한 '골절'이라도 부상 부위(손가락 vs 척추)에 따라 심각도 점수는 다르게 산정됩니다.


#### 6.2.2 DT 코드별 심각도 기본값

각 DT 코드에는 심각도 범위(최소~최대)가 매핑되어 있다. 실제 평가 시에는 §6.3의 최악 시나리오 원칙에 따라 최종 심각도를 결정한다.

| 심각도 | 기본 대응 DT 코드 |
|:---:|---|
| 5 (사망) | `DT.BODY.DEATH`, `DT.ASPHYX.DROWN`(최대), `DT.THERMAL.FIRE`(최대), `DT.ASPHYX.CHOKE`(최대) |
| 4 (치명적) | `DT.THERMAL.FIRE`, `DT.ELECTRIC.SHOCK`(최대), `DT.ASPHYX.STRANG`(최대) |
| 3 (중증) | `DT.ASPHYX.CHOKE`, `DT.ASPHYX.STRANG`, `DT.THERMAL.BURN`(최대), `DT.CHEMICAL.POISON`(최대) |
| 2 (보통) | `DT.MECHANICAL.INJ`, `DT.CHEMICAL.POISON`, `DT.THERMAL.BURN` |
| 1 (경미) | `DT.BODY.SENSE`, `DT.MECHANICAL.FALL`, `DT.NON-PHYS.PSYCH` |
| 0 (무시가능) | `DT.OTHER.NEARMI`, `DT.NON-PHYS.ECON` |

---

### 6.3 심각도 산출: 최악 시나리오 우선 원칙

#### 6.3.1 원칙

사고 심각도(Severity)를 평가할 때, **실제 발생한 피해**뿐 아니라 **합리적으로 예견 가능한 최악의 시나리오**를 반드시 함께 고려해야 한다. 두 값 중 더 높은 심각도를 최종 등급으로 채택한다.

> **[예시]** 교차로에서 신호 위반 차량이 다행히 사고 없이 지나갔더라도(실제 피해 = 0), 그 교차로의 위험도를 "0"으로 평가하지 않는다. "만약 보행자가 있었다면?"이라는 최악 시나리오를 반영해 교통 안전 대책을 수립하는 것과 같다.

#### 6.3.2 국제 표준 근거

| 출처                          | 근거 조항                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| **ISO 12100:2010 §5.5.2.2** | 가장 가능성 높은 심각도를 고려하되, "발생 확률이 낮더라도 예견 가능한 최고 심각도(highest foreseeable severity)를 반드시 고려해야 한다" |
| **EU 2019/417 §8**          | "여러 시나리오 중 제품의 최고 위험 수준을 나타내는 시나리오를 선택한다. 최고 위험이 곧 해당 제품의 위험이다"                             |
| **PRISM v2.0 Stage (v)**    | 심각도 결정 시 "해당 위해가 대상자에게 미칠 영향"을 시나리오 맥락에서 평가. 취약계층(어린이, 노인)에 대한 별도 시나리오 요구                   |
| **METI 리스크 어세스먼트 핸드북**      | 5단계 심각도(Fatal→Negligible) 기반, 제품의 구조적 특성에서 예견 가능한 최대 피해를 기준으로 평가                            |
|                             |                                                                                             |
|                             |                                                                                             |

#### 6.3.3 실무 적용 가이드

**핵심 규칙**: 현재 발생한 피해가 1점(경미)이라도, 제품의 구조적 특성상 4점(치명적)으로 번질 가능성이 크다면 **4점을 선택**한다.

```
적용 예시:
  [사례] 보조배터리에서 그을음 발생 (실제 피해: 찰과상 = 1점)
  
  → 최악 시나리오 검토:
    배터리 구조상 열폭주 → 화재 → 주거 환경 대형 화재 가능
    ∴ 최악 시나리오 심각도 = 4점 (치명적)
    
  → 최종 심각도: max(1, 4) = 4점 선택
  → DT 코드: DT.THERMAL.FIRE (Primary), DT.MECHANICAL.INJ (Secondary)
```

> **[주의]** 최악 시나리오는 "상상할 수 있는 모든 것"이 아니라, **해당 제품의 구조적 특성에서 합리적으로 예견 가능한 범위** 내의 시나리오이다. ISO 12100의 "reasonably foreseeable" 기준을 적용한다.

---

### 6.4 EU Safety Gate Type of Risk ↔ DT 코드 전항목 매핑

| EU Safety Gate 공식 분류    | 한국어       | 대응 DT 코드                                                   |
| ----------------------- | --------- | ---------------------------------------------------------- |
| Chemical                | 화학적 위험    | `DT.CHEMICAL.POISON`                                       |
| Injuries                | 부상·상해     | `DT.MECHANICAL.INJ`, `DT.MECHANICAL.FALL`, `DT.BODY.DEATH` |
| Environmental           | 환경 위험     | `DT.CHEMICAL.ENV`                                          |
| Electric Shock          | 감전        | `DT.ELECTRIC.SHOCK`                                        |
| Choking                 | 질식        | `DT.ASPHYX.CHOKE`                                          |
| Fire                    | 화재·화상     | `DT.THERMAL.FIRE`, `DT.THERMAL.BURN`                       |
| Strangulation           | 목 졸림      | `DT.ASPHYX.STRANG`                                         |
| Drowning                | 익사·익수     | `DT.ASPHYX.DROWN`                                          |
| Damage to hearing/sight | 청각·시각 손상  | `DT.BODY.SENSE`                                            |
| Property damage         | 재산 피해     | `DT.NON-PHYS.PROP`                                         |
| Energy resources        | 에너지 자원 위반 | `DT.CHEMICAL.ENV` (에너지 규정 위반)                              |
| — (PRISM 2024 확장)       | 심리적 피해    | `DT.NON-PHYS.PSYCH`                                        |
| — (GPSR 2024 확장)        | 경제적 손실    | `DT.NON-PHYS.ECON`                                         |

---

<div style="page-break-before: always;"></div>

## §7. 코드 적용 방법

### 7.1 M-SHELL 모델 연계 매핑 구조

ISO 5665:2024 M-SHELL 분석과 HF 코드의 체계적 연계:

```
M-SHELL 요소         HF 대분류      위해요인(HF.) 코드 연계                피해유형(DT.)
──────────────────────────────────────────────────────────────────────────────────────
M (관리)     → HF.M →  HF.M.DES, HF.M.QMS                    →  모든 DT 코드
S (절차/기준) → HF.S →  HF.S.QC, HF.S.PROC, HF.S.NATL.DEF    →  모든 DT 코드
H (하드웨어) → HF.H →  HF.H.ELEC.*, HF.H.PHY.*, HF.H.CHEM.* →  해당 DT 코드
E (환경)     → HF.E →  HF.E.THERM, HF.E.MOIST, HF.E.USE      →  DT.THERMAL.FIRE, DT.THERMAL.BURN 등
L (사용자)   → HF.L0→  HF.L0.CHILD, HF.L0.MISUSE             →  DT.ASPHYX.CHOKE, DT.ASPHYX.STRANG
L (관련자)   → HF.L1→  HF.L1.GUARD, HF.L1.RETAIL            →  (피해 예방 관련)
```

### 7.2 실제 리콜 사례 적용 예시

| 리콜 사례 | M-SHELL 분석 | HF (위해요인) | DT (피해유형) | 출처 |
|---|---|---|---|---|
| 자석 물풍선 (영국) | H: 접근가능 소형자석, L: 어린이 | `HF.H.PHY.SMALL`, `HF.H.PHY.MAG` | `DT.ASPHYX.CHOKE` | EU Safety Gate |
| 보조배터리 과열 (프랑스) | H: 열관리 결함, M: 설계검토 누락 | `HF.H.ELEC.OHT`, `HF.M.DES` | `DT.THERMAL.FIRE`, `DT.THERMAL.BURN` | EU Safety Gate |
| 전기청소기 절연불량 (영국) | H: 절연 결함, S: 안전기준 미준수 | `HF.H.ELEC.INS`, `HF.S.NATL.DEF` | `DT.ELECTRIC.SHOCK` | EU Safety Gate |
| 유아복 끈 (캐나다) | H: 끈 구조, M: 안전설계 기준 미적용 | `HF.H.PHY.CORD`, `HF.M.DES` | `DT.ASPHYX.STRANG` | OECD GlobalRecalls |
| 가구 포름알데히드 (중국) | H: 유해물질 함유 재료 | `HF.H.CHEM.FORM` | `DT.CHEMICAL.POISON` | EU Safety Gate |
| 리튬배터리 팽창 (호주) | H: 배터리 셀 불량, S: 품질검수 미비 | `HF.H.ELEC.BAT`, `HF.S.QC` | `DT.THERMAL.FIRE` | OECD GlobalRecalls |
| BMHCA 화장품 (EU, 2024) | H: 금지 향료 성분 함유 | `HF.H.CHEM.FRAG` | `DT.CHEMICAL.POISON` | EU Safety Gate 2024 |
| 전선 케이블 SCCP (EU, 2024) | H: 환경 잔류 유해물질 | `HF.H.CHEM.SCCP` | `DT.CHEMICAL.ENV`, `DT.CHEMICAL.POISON` | EU Safety Gate 2024 |
| 어린이 부력완장 (OECD) | H: 부력 설계 결함 | `HF.H.PHY.WATER`, `HF.M.DES` | `DT.ASPHYX.DROWN` | OECD GlobalRecalls |


### 7.3 통계 대시보드 활용 방안

#### 7.3.1 단일 코드 vs. 이중 코드: 무엇이 달라지나?

기존 `위해유형` 단일 코드는 원인과 결과를 하나의 칸에 담았기 때문에 "원인을 알면 결과를 모르고, 결과를 알면 원인을 모르는" 구조였다. HF·DT 이중 코드 도입 후에는 아래 질문 모두에 SQL 한 줄로 답할 수 있다.

| 질문 | 단일 코드 (현행) | HF·DT 이중 코드 (개선 후) |
|---|:---:|:---:|
| "배터리 리콜이 몇 건인가?" | 가능 | 가능 |
| "배터리 리콜 중 화재가 몇 %인가?" | **불가** (원인·결과 혼재) | **가능** |
| "화재 사고의 원인 1위는?" | **불가** | **가능** |
| "어린이 완구에서 가장 위험한 피해 유형은?" | **불가** | **가능** |

#### 7.3.2 교차 분석 쿼리 예시

**예시 1 — 배터리 결함 리콜 중 화재 비율**

> "배터리 결함(`HF.H.ELEC.BAT`) 리콜 중 화재(`DT.THERMAL.FIRE`)는 몇 %인가?"

```sql
SELECT
  COUNT(*) FILTER (WHERE 'DT.THERMAL.FIRE' = ANY(damage_type_codes)) AS fire_count,
  COUNT(*)                                                    AS total_bat,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE 'DT.THERMAL.FIRE' = ANY(damage_type_codes)) / COUNT(*), 1
  ) AS fire_pct
FROM incidents
WHERE hazard_factor_code = 'HF.H.ELEC.BAT';
-- 결과 예시: fire_count=23, total_bat=41, fire_pct=56.1 %
```

**예시 2 — 화재 사고의 원인 분포**

> "화재(`DT.THERMAL.FIRE`) 사고의 원인 중 설계 결함(`HF.M.DES`)은 몇 건인가?"

```sql
SELECT
  hazard_factor_code,
  COUNT(*) AS cnt
FROM incidents
WHERE 'DT.THERMAL.FIRE' = ANY(damage_type_codes)
GROUP BY hazard_factor_code
ORDER BY cnt DESC;
-- 결과 예시: HF.H.ELEC.BAT 23건, HF.M.DES 18건, HF.H.ELEC.OHT 7건 …
```

**예시 3 — 어린이 완구 피해유형 Top 5**

> "어린이 완구 리콜에서 가장 많이 발생하는 피해 유형은?"

```sql
SELECT
  unnest(damage_type_codes) AS dt_code,
  COUNT(*) AS cnt
FROM incidents
WHERE product_category = '완구'
  AND age_group_affected = '어린이'
GROUP BY dt_code
ORDER BY cnt DESC
LIMIT 5;
-- 결과 예시: DT.ASPHYX.CHOKE 41건, DT.MECHANICAL.INJ 28건, DT.ASPHYX.STRANG 12건 …
```

#### 7.3.3 대시보드 패널 설계 방향

| 패널 이름      | X축        | Y축                  | 주요 필터                |
| ---------- | --------- | ------------------- | -------------------- |
| 원인-결과 히트맵  | HF 중분류    | DT 코드               | 기간, 제품군              |
| 리스크 버블 차트  | 발생 빈도(HF) | 피해 심각도(DT Severity) | M-SHELL 대분류          |
| 시계열 트렌드    | 월별        | 리콜 건수               | HF 또는 DT 선택          |
| 제품군 × 피해유형 | 제품 카테고리   | DT 코드               | 연도, PRISM Risk Level |

> **[개발]** `damage_type_codes[]` 배열 필드를 유지하면 단일 SELECT로 HF와 DT를 동시 조회할 수 있다 ([[#A.1 마스터 테이블 추가|부록 A §A.1 스키마]] 참조).

#### 7.3.4 기존 집계 쿼리 (단일 코드로도 가능)

- **M-SHELL 대분류별 리콜 빈도**: `GROUP BY mshell_level1` 쿼리로 H/S/M/E/L0/L1 분포 분석
- **리스크 등급 분포**: PRISM Risk Level별 리콜 건수 → 심각 리콜 비중 추적
- **글로벌 리콜 트렌드 비교**: OECD GlobalRecalls 및 EU Safety Gate 데이터와 정기 비교 (부록 F·G 참조)

---

<div style="page-break-before: always;"></div>


## 부록 A (규범적) — DB 스키마 변경 방안

### A.1 마스터 테이블 추가

```sql
-- 위해요인 마스터 테이블 (점 표기 코드 체계)
CREATE TABLE hazard_factor_master (
    code              VARCHAR(30) PRIMARY KEY,     -- 예: HF.H.ELEC.NPC
    mshell_level1     VARCHAR(5)  NOT NULL,        -- H / S / M / E / L0 / L1 / UNKNOWN
    category_l2       VARCHAR(10),                 -- ELEC / PHY / CHEM / STD / QC / PROC / DES / QMS 등
    category_l3       VARCHAR(10),                 -- NPC / INS / OHT / BAT / SMALL 등 소분류
    name_ko           VARCHAR(100) NOT NULL,        -- 보호회로 부재
    name_en           VARCHAR(100),                 -- No Protection Circuit
    eu_safetygate_risk VARCHAR(50),               -- EU Safety Gate Type of Risk 대응
    prism_hazard_type VARCHAR(50),                 -- PRISM v2.0 위해 유형 대응
    is_recall_common  BOOLEAN DEFAULT TRUE,         -- 리콜 통계에 빈번히 사용 여부 (L0/L1은 FALSE)
    description       TEXT,
    is_active         BOOLEAN DEFAULT TRUE,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- 피해유형 마스터 테이블 (DT.GROUP.CODE)
CREATE TABLE damage_type_master (
    code                   VARCHAR(30) PRIMARY KEY,   -- 예: DT.THERMAL.FIRE
    dt_group               VARCHAR(15) NOT NULL,      -- 중분류: THERMAL/ELECTRIC/MECHANICAL/ASPHYX/CHEMICAL/BODY/NON-PHYS/OTHER
    name_ko                VARCHAR(100) NOT NULL,      -- 화재/폭발
    name_en                VARCHAR(100),
    iso5665_severity_min   INTEGER,               -- ISO 5665 최소 심각도 (0~5)
    iso5665_severity_max   INTEGER,               -- ISO 5665 최대 심각도 (0~5)
    prism_risk_level       VARCHAR(10),           -- Low / Medium / High / Serious
    eu_safetygate_type     VARCHAR(50),           -- EU Safety Gate 공식 Type of Risk 대응
    gpsr_harm_category     VARCHAR(50),           -- GPSR 2024 harm 카테고리
    description            TEXT,
    is_active              BOOLEAN DEFAULT TRUE,
    created_at             TIMESTAMPTZ DEFAULT NOW()
);
```

> **[비고]** L0·L1 코드는 리콜 통계에서 단독 사용이 드물고 오입력 방지가 필요하므로 `is_recall_common = FALSE`로 설정. 시스템 입력 화면에서 기본 드롭다운 목록에 표시되지 않으며, 담당자가 별도로 활성화한 후 선임 담당자 확인을 거쳐 입력.

### A.2 사고조사 테이블 필드 추가

```sql
-- 기존 incidents 테이블에 필드 추가
ALTER TABLE incidents
    ADD COLUMN hazard_factor_code VARCHAR(30)    -- 주된 위해요인 코드 (FK)
        REFERENCES hazard_factor_master(code),
    ADD COLUMN hazard_factor_sub  TEXT[]         -- 복수 위해요인 코드 (부차적 원인)
        DEFAULT '{}',                             -- 예: ['HF.H.ELEC.OHT', 'HF.M.DES']
    ADD COLUMN damage_type_primary VARCHAR(30)   -- 주요 피해유형 (Primary DT, 1개 필수)
        REFERENCES damage_type_master(code),
    ADD COLUMN damage_type_secondary TEXT[]      -- 부수 피해유형 (Secondary DT, 배열)
        DEFAULT '{}',                             -- 예: ['DT.THERMAL.BURN']
    ADD COLUMN damage_type_codes  TEXT[]          -- 전체 피해유형 코드 배열 (Primary + Secondary)
        DEFAULT '{}',                             -- 예: ['DT.THERMAL.FIRE', 'DT.THERMAL.BURN']
    ADD COLUMN iso5665_severity_actual INTEGER   -- 실제 발생 피해 심각도 (0~5)
        CHECK (iso5665_severity_actual BETWEEN 0 AND 5),
    ADD COLUMN iso5665_severity_worst  INTEGER   -- 최악 시나리오 심각도 (0~5)
        CHECK (iso5665_severity_worst BETWEEN 0 AND 5),
    ADD COLUMN iso5665_severity   INTEGER         -- 최종 심각도 = max(actual, worst)
        CHECK (iso5665_severity BETWEEN 0 AND 5),
    ADD COLUMN prism_risk_level   VARCHAR(10)     -- PRISM v2.0 Risk Level
        CHECK (prism_risk_level IN ('Low', 'Medium', 'High', 'Serious')),
    ADD COLUMN gpc_brick_code     VARCHAR(10)     -- GPC Brick 코드 (OECD 연동)
        DEFAULT NULL;

-- 최종 심각도 자동 산출 트리거
CREATE OR REPLACE FUNCTION calc_final_severity()
RETURNS TRIGGER AS $$
BEGIN
    NEW.iso5665_severity := GREATEST(
        COALESCE(NEW.iso5665_severity_actual, 0),
        COALESCE(NEW.iso5665_severity_worst, 0)
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_calc_severity
BEFORE INSERT OR UPDATE ON incidents
FOR EACH ROW EXECUTE FUNCTION calc_final_severity();

-- 인덱스 생성 (통계 쿼리 최적화)
CREATE INDEX idx_incidents_hazard_factor  ON incidents(hazard_factor_code);
CREATE INDEX idx_incidents_mshell_level   ON incidents((split_part(hazard_factor_code, '.', 2)));
CREATE INDEX idx_incidents_damage_types   ON incidents USING GIN(damage_type_codes);
CREATE INDEX idx_incidents_dt_primary     ON incidents(damage_type_primary);
CREATE INDEX idx_incidents_dt_group       ON incidents((split_part(damage_type_primary, '.', 2)));
CREATE INDEX idx_incidents_severity       ON incidents(iso5665_severity);
CREATE INDEX idx_incidents_risk_level     ON incidents(prism_risk_level);
CREATE INDEX idx_incidents_gpc_brick      ON incidents(gpc_brick_code);
```

> **[적용 기준]** 심각도가 더 높은 DT 코드가 Primary. 통계 집계 시 Primary DT만 카운트하여 중복 계산을 방지한다. 전체 배열(`damage_type_codes`)은 상세 분석용으로 유지한다.

### A.3 레거시(기존 엑셀파일 값) 데이터 매핑 테이블

기존 `위해유형` 단일 값 및 v0.3 하이픈 코드를 점 표기 코드로 마이그레이션하기 위한 매핑 테이블:

```sql
CREATE TABLE legacy_hazard_mapping (
    legacy_value        VARCHAR(100) PRIMARY KEY, -- 기존 값 (예: '감전위험', 'HF-ELEC-INS')
    hazard_factor_code  VARCHAR(30),               -- HF. 코드
    damage_type_codes   TEXT[],                    -- DT. 코드 배열
    confidence          VARCHAR(10),               -- HIGH / MEDIUM / LOW
    notes               TEXT                       -- 판단 근거 메모
);
```

**레거시(기존 엑셀파일 값) 매핑 예시**:

| 기존 위해유형 값 | v0.5 코드 | 피해유형(DT.) | 신뢰도 |
|---|---|---|:---:|
| 감전위험 | `HF.H.ELEC.INS` | `['DT.ELECTRIC.SHOCK']` | HIGH |
| 화재위험 | `HF.H.ELEC.OHT` | `['DT.THERMAL.FIRE']` | HIGH |
| 화상위험 | `HF.H.ELEC.OHT` | `['DT.THERMAL.BURN']` | MEDIUM |
| 유해물질 | `HF.H.CHEM.ETC` | `['DT.CHEMICAL.POISON']` | MEDIUM |
| 질식위험 | `HF.H.PHY.SMALL` | `['DT.ASPHYX.CHOKE']` | HIGH |
| 파손/파편 | `HF.H.PHY.FRAC` | `['DT.MECHANICAL.INJ']` | HIGH |
| 목 조임 | `HF.H.PHY.CORD` | `['DT.ASPHYX.STRANG']` | HIGH |
| 환경오염 | `HF.H.CHEM.SCCP` | `['DT.CHEMICAL.ENV']` | MEDIUM |
| 설계결함 | `HF.M.DES` | (사례별 상이) | MEDIUM |
| 공정불량 | `HF.S.PROC` | (사례별 상이) | MEDIUM |
| 기타/미확인 | `HF.UNKNOWN` | `['DT.OTHER.NEARMI']` | LOW |

### A.4 레거시 DT 코드 매핑 테이블 

기존 하이픈 표기 DT 코드(`DT-FIRE`)를 신규 점 계층 표기(`DT.THERMAL.FIRE`)로 마이그레이션하기 위한 매핑 테이블:

```sql
CREATE TABLE legacy_dt_mapping (
    legacy_dt_code      VARCHAR(30) PRIMARY KEY, -- 기존 DT-FIRE 형식
    new_dt_code         VARCHAR(30) NOT NULL,    -- 신규 DT.THERMAL.FIRE 형식
    dt_group            VARCHAR(15) NOT NULL     -- 중분류 그룹
);

-- 매핑 데이터 입력
INSERT INTO legacy_dt_mapping VALUES
    ('DT-FIRE',       'DT.THERMAL.FIRE',      'THERMAL'),
    ('DT-BURN',       'DT.THERMAL.BURN',      'THERMAL'),
    ('DT-ELEC-SHOCK', 'DT.ELECTRIC.SHOCK',    'ELECTRIC'),
    ('DT-MECH-INJ',   'DT.MECHANICAL.INJ',    'MECHANICAL'),
    ('DT-FALL',       'DT.MECHANICAL.FALL',    'MECHANICAL'),
    ('DT-CHOKE',      'DT.ASPHYX.CHOKE',      'ASPHYX'),
    ('DT-STRANG',     'DT.ASPHYX.STRANG',     'ASPHYX'),
    ('DT-DROWN',      'DT.ASPHYX.DROWN',      'ASPHYX'),
    ('DT-POISON',     'DT.CHEMICAL.POISON',    'CHEMICAL'),
    ('DT-ENV',        'DT.CHEMICAL.ENV',       'CHEMICAL'),
    ('DT-DEATH',      'DT.BODY.DEATH',         'BODY'),
    ('DT-SENSE',      'DT.BODY.SENSE',         'BODY'),
    ('DT-PSYCH',      'DT.NON-PHYS.PSYCH',    'NON-PHYS'),
    ('DT-ECON',       'DT.NON-PHYS.ECON',     'NON-PHYS'),
    ('DT-PROP',       'DT.NON-PHYS.PROP',     'NON-PHYS'),
    ('DT-NEARMI',     'DT.OTHER.NEARMI',       'OTHER');
```


---

<div style="page-break-before: always;"></div>

## 부록 B (참고) — 사고조사 대장 엑셀 적용 예시

### B.1 추가 컬럼 구조 (현행 → 개선)

현행 `위해유형` 단일 컬럼에 아래 신규 컬럼을 추가한다. 기존 컬럼은 마이그레이션 완료 전까지 병행 유지한다.

| 컬럼명 (Excel 헤더) | 데이터 형식 | 기존/신규 | 설명 | 예시 값 |
|---|:---:|:---:|---|---|
| 접수번호 | TEXT | 기존 | 연도-일련번호 | 2025-0001 |
| 접수일자 | DATE | 기존 | | 2025-03-15 |
| 제품명 | TEXT | 기존 | | 리튬이온 보조배터리 |
| 제품분류 | TEXT | 기존 | 기존 분류 유지 | 전기용품 |
| 위해유형 (기존 엑셀파일 값·레거시) | TEXT | 기존 | 마이그레이션 전까지 유지 | 화재위험 |
| **위해요인 코드 (HF)** | VARCHAR(30) | **신규** | 주된 원인 코드 1개 (Hazard Factor) | `HF.H.ELEC.BAT` |
| **복수 위해요인 (HF_sub)** | TEXT (쉼표 구분) | **신규** | 부차 원인 코드 (복수 가능) | `HF.M.DES` |
| **피해유형 코드 (DT)** | TEXT (쉼표 구분) | **신규** | 피해 유형 코드 (복수 가능, Damage Type) | `DT.THERMAL.FIRE, DT.THERMAL.BURN` |
| **M-SHELL 대분류** | TEXT | **신규 (자동)** | HF 코드 2번째 점(.) 이전 값 자동 추출 | `H` |
| **ISO 심각도 (0~5)** | INTEGER | **신규** | 0=아차사고, 5=사망 | `4` |
| **PRISM 위험등급** | TEXT | **신규** | Low / Medium / High / Serious | `Serious` |
| 조치결과 | TEXT | 기존 | | 자진 리콜 |

---

### B.2 적용 예시 (5개 사례)

| 접수번호 | 제품명 | 위해유형(기존) | 위해요인 HF (원인) | 복수위해요인 HF_sub | 피해유형 DT (결과) | M-SHELL | ISO심각도 | PRISM등급 |
|---|---|---|---|---|---|:---:|:---:|:---:|
| 2025-0001 | 리튬이온 보조배터리 | 화재위험 | `HF.H.ELEC.BAT` | `HF.M.DES` | `DT.THERMAL.FIRE, DT.THERMAL.BURN` | H | 4 | Serious |
| 2025-0002 | 어린이 자석블록 완구 | 질식위험 | `HF.H.PHY.MAG` | `HF.H.PHY.SMALL` | `DT.ASPHYX.CHOKE` | H | 4 | Serious |
| 2025-0003 | 유아용 점퍼 (목 끈) | 목조임위험 | `HF.H.PHY.CORD` | `HF.M.DES` | `DT.ASPHYX.STRANG` | H | 4 | Serious |
| 2025-0004 | 가정용 핸드블렌더 | 감전위험 | `HF.H.ELEC.INS` | `HF.S.NATL.DEF` | `DT.ELECTRIC.SHOCK, DT.THERMAL.BURN` | H | 3 | High |
| 2025-0005 | 유아 스킨케어 로션 | 유해물질 | `HF.H.CHEM.FORM` | `HF.S.NATL.DEF` | `DT.CHEMICAL.POISON` | H | 2 | Medium |

> **[예시]** 2025-0001**: "배터리 셀 결함(`HF.H.ELEC.BAT`, Hardware/전기)이 주된 원인이고, 설계 검토 누락(`HF.M.DES`, Management)도 기여. 그 결과 화재(`DT.THERMAL.FIRE`)와 화상(`DT.THERMAL.BURN`) 두 가지 피해 발생. ISO 심각도 4 → PRISM Serious 등급."

---

### B.3 엑셀 수식 활용 팁

HF 코드에서 M-SHELL 대분류를 **자동 추출**하는 수식 (G열이 HF 코드 컬럼인 경우):

```
=MID(G2, 4, FIND(".", G2, 4) - 4)

결과 예시:
  "HF.H.ELEC.BAT" → "H"
  "HF.S.QC"       → "S"
  "HF.M.DES"      → "M"
  "HF.L0.CHILD"   → "L0"
  "HF.UNKNOWN"    → "UNKNOWN"
```

DT 코드 기반 **ISO 심각도 기본값** 자동 입력:

```
=IFERROR(VLOOKUP(LEFT(I2, FIND(",",I2&",")-1), DT기준표!$A:$B, 2, FALSE), "")

※ DT기준표 시트 매핑:
  DT.BODY.DEATH=5  DT.THERMAL.FIRE=4  DT.ELECTRIC.SHOCK=3  DT.ASPHYX.CHOKE=4
  DT.ASPHYX.STRANG=4  DT.THERMAL.BURN=3  DT.MECHANICAL.INJ=2  DT.CHEMICAL.POISON=3
  DT.BODY.SENSE=1  DT.MECHANICAL.FALL=1  DT.CHEMICAL.ENV=1  DT.NON-PHYS.PROP=1
  DT.OTHER.NEARMI=0  DT.NON-PHYS.PSYCH=1  DT.NON-PHYS.ECON=0  DT.ASPHYX.DROWN=5
```

### B.4 도입 권장 순서

1. **신규 접수부터 즉시 적용**: 신규 사고 접수 시 HF·DT 코드 입력 시작. 기존 `위해유형` 컬럼과 **병행 기록**하여 마이그레이션 전까지 이중 관리
2. **레거시(기존 엑셀파일 값) 데이터 변환**: 부록 A.3 매핑 테이블 기반 배치 변환 → LOW 신뢰도 항목은 담당자 수동 확인
3. **PRISM 위험등급 1단계**: ISO 심각도(DT 코드 기반 기본값) 우선 적용 → 이후 출하량·노출 인구 데이터 연계로 Probability 반영하여 정밀화

---

<div style="page-break-before: always;"></div>

## 부록 C (참고) — 참조 문서 및 출처

### C.1 참조 표준 및 법규

| 구분     | 문서명                                               | 비고                         |
| ------ | ------------------------------------------------- | -------------------------- |
| 국제 표준  | ISO 5665:2024 Consumer incident investigation     | M-SHELL: Annex A.4         |
| EU 법령  | EU GPSR (EU) 2023/988 (발효: 2024-12-13)            | 기존 GPSD(2001/95/EC) 대체     |
| 리스크평가  | PRISM v2.0 (UK OPSS, 2024-10)                     | 6단계 리스크 프로세스, Risk 4등급     |
| 리스크평가  | CENELEC Guide 32:2014                             | 전기제품 리스크 평가 가이드            |
| 리스크평가  | ISO 12100:2010 Safety of machinery                | 합리적 예견가능 오용 개념             |
| 리스크평가  | EU 2019/417 (RAPEX Guidelines)                    | 리콜 조치 8단계 계층               |
| 리스크평가  | RIVM Toy Risk Assessment (2008)                   | 화학 노출경로 6가지                |
| 리스크평가  | METI リスクアセスメント・ハンドブック (2011)           | 심각도 5단계(Fatal~Negligible), 리스크 어세스먼트 실무 가이드 |
| EU 법령  | Commission Implementing Regulation (EU) 2024/3173 | Safety Gate 운영 및 위험 평가 방법론 |


### C.2 조사 출처

- [OECD GlobalRecalls Portal](https://globalrecalls.oecd.org)
- [EU Safety Gate](https://ec.europa.eu/safety-gate-alerts)
- [EU Safety Gate 2024 Annual Report](https://ec.europa.eu/commission/presscorner/detail/en/ip_25_1064)
- [PRISM v2.0 (UK OPSS, 2024-10)](https://www.gov.uk/government/publications/opss-product-safety-risk-assessment-methodology)
- [ISO 12100:2010](https://www.iso.org/standard/51528.html)
- [CENELEC Guide 32:2014](https://www.cenelec.eu)
- [Commission Implementing Regulation (EU) 2024/3173](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=PI_COM:C(2024)6023)
- [GS1 GPC Overview](https://www.gs1.org/resources/articles/organisation-economic-co-operation-and-development-oecd-uses-gpc-their-globalrecals-portal)
- [RIVM Report 320003001/2008](https://www.rivm.nl/bibliotheek/rapporten/320003001.pdf)

---

<div style="page-break-before: always;"></div>

## 부록 D (참고) — 개발 로드맵

### D.1 단계별 추진 일정

- **1단계: 기반 구축** (4주)
  - 마스터 테이블(`hazard_factor_master`, `damage_type_master`) 기준으로 생성 및 데이터 입력
    - HF 코드: v0.9.5 현행 총 50개 (HF.UNKNOWN 포함; v0.5 대비 HF.H.SW·HF.S 세분화·HF.L 취약계층 추가)
    - DT 코드: v0.3 14개 → v0.4/v0.5 신규 2개 포함 총 16개
  - `incidents` 테이블 신규 컬럼 추가 (무중단 ALTER TABLE)
  - 레거시(기존 엑셀파일 값) 매핑 테이블 구축 및 기존 데이터 배치 마이그레이션 실행 (v0.3 하이픈 → 점 표기)

- **2단계: 운영 검증** (4주)
  - 담당자 대상 신규 분류 코드 교육 (점 표기 체계, M-SHELL 6요소 대분류 설명 포함)
  - 신규 접수 건 대상 이중 입력 테스트 (기존 + 신규 병행 운영)
  - 레거시(기존 엑셀파일 값) LOW 신뢰도 항목 수동 검토 및 보정

- **3단계: 고도화** (8주)
  - PRISM Risk Level 자동 산출 모듈 설계 (DT Severity × 출하량 데이터)
  - 대시보드 통계 쿼리 및 시각화 개발 (M-SHELL 분포, EU Safety Gate 비교 포함)
  - n8n AI 자동 분류 워크플로우 설계 및 파일럿 운영 ([[#부록 E (참고) — n8n 워크플로우 연계 방안|부록 E]] 참조)
  - OECD GlobalRecalls API 및 EU Safety Gate 자동 매핑 연동 테스트

### D.2 추진 리스크 및 전제 조건

| 위험 요소                     | 영향                 | 대응 방안                                    |
| ------------------------- | ------------------ | ---------------------------------------- |
| 점 표기(.) 코드 마이그레이션         | v0.3 하이픈 코드 혼재     | 부록 A.3 매핑 테이블 기반 일괄 변환 스크립트 실행           |
| L0/L1 코드 오용               | 제조자 책임 희석 우려       | 제품위해정보분류시스템 드롭다운 기본 목록 제외, 선임 담당자 확인 필수  |
| DT.NON-PHYS.PSYCH·DT.NON-PHYS.ECON 측정 어려움   | 피해 규모 산정 기준 부재     | 초기에는 피해 신고 내용 기반 주관적 판단 허용; 향후 측정 기준 개발  |
| PRISM Risk Level 자동화 정확도  | Probability 데이터 부재 | 1단계에서는 Severity 기반 기본값 부여, 이후 출하량 데이터 연계 |
| 레거시(기존 엑셀파일 값) 데이터 품질 불균일 | 마이그레이션 오류          | LOW 신뢰도 항목 수동 검토 절차 필수                   |

### D.3 성과 지표

| 지표 | 기준치 (As-Is) | 목표치 (To-Be) |
|---|---|---|
| 위해요인 분류 완성도 | 단일 값, 원인·결과 혼재 | HF/DT 이중 코드화 100% |
| HF 코드 M-SHELL 체계성 | M-SHELL 미적용 | 30개 HF 코드 전항목 M-SHELL 6요소 대분류 적용 |
| 국제 정합성 (EU Safety Gate) | 연계 없음 | EU Type of Risk 11개 전항목 DT 대응 코드 완비 |
| 리스크평가 연계 | 없음 | PRISM Risk Level 필드 DB 반영, DT Severity 매핑 완료 |
| 레거시(기존 엑셀파일 값) 데이터 마이그레이션 | 0% | 기존 데이터의 90% 이상 자동 매핑 |
| 통계 대시보드 활용 지표 수 | 1개 (단순 위해유형 빈도) | 6개 이상 (M-SHELL 분포·원인별·피해별·리스크 등급·교차·글로벌 비교) |

---

<div style="page-break-before: always;"></div>

## 부록 E (참고) — n8n 워크플로우 연계 방안

AI 기반 자동 분류를 n8n으로 구현하는 방안을 검토한다.

| 항목 | 현행 (As-Is) | 개선안 (To-Be) | 상태 |
|---|---|---|:---:|
| 분류 입력 방식 | 담당자 수동 입력 | AI 초안 제시 → 담당자 확인 승인 | 검토 중 |
| 입력 데이터 | 위해유형 1개 필드 | `hazard_factor_code` + `damage_type_codes[]` | 검토 중 |
| AI 활용 범위 | 없음 | 사고 접수 내용 기반 자동 코드 추천 (HF. 점 표기) | 검토 중 |
| OECD GlobalRecalls 연동 | 수동 검토 | n8n 스케줄 → API → GPC/HF./DT. 자동 매핑 | 검토 중 |
| EU Safety Gate 연동 | 수동 검토 | n8n 스케줄 → 주간 보고서 → Type of Risk 자동 분류 | 검토 중 |
| 리스크 등급 자동 산출 | 없음 | DT Severity × 출하량/노출 인구 → PRISM Risk Level | 검토 중 |

---


## 부록 F (참고) — OECD GPC 기반 제품 카테고리 연계 방안

OECD GlobalRecalls 포털과 데이터 연동을 위해 GS1 GPC 표준 기반 제품 카테고리 코드 연계를 검토한다.

**GPC 4단계 계층 구조**:
```
Segment (대분류)
 └─ Family (중분류)
     └─ Class (소분류)
          └─ Brick (개별 제품군, 8자리 코드)
```

**예시**: Brick Code `10000223` = Cola (Soft Drinks Class)

**시스템 연계 설계안**:

```sql
-- incidents 테이블에 GPC Brick 코드 필드 추가 (검토 중)
ALTER TABLE incidents
    ADD COLUMN gpc_brick_code VARCHAR(10)   -- 8자리 GPC Brick 코드 (OECD 연동용)
        DEFAULT NULL;

-- OECD 주요 리콜 집중 제품군 예시
-- 완구(Toys/Games), 의류(Clothing/Apparel), 전기기기(Electrical Appliances)
-- 화장품(Cosmetics), 자동차(Motor Vehicles), 화학제품(Chemical Products)
```

> **[비고]** 코드 체계 1단계(HF/DT 코드) 적용 완료 후 2단계로 GPC 코드 연계 검토.

---

<div style="page-break-before: always;"></div>

## 부록 G (참고) — AI 분류 학습용 키워드 사전

n8n AI 자동 분류 워크플로우(부록 E 참조)에서 사고 개요 텍스트를 분석할 때 활용하는 키워드-코드 매핑 사전이다. 초기에는 고빈도 사고 유형 중심으로 정의하며, 운영하면서 확장한다.

### G.1 HF 코드 키워드 매핑

| 키워드 그룹 | 키워드 예시 | 연결 HF 코드 | 우선 중분류 |
|---|---|---|---|
| 전기/배터리 | 폭발, 터짐, 연기, 발화, 충전, 과열, 합선, 스파크 | `HF.H.ELEC` | ELEC |
| 배터리 특화 | 배터리, 리튬, 전해액, 팽창, 충전기 | `HF.H.ELEC.BAT` | ELEC |
| 과열/열적 | 뜨거움, 녹음, 변형, 그을음, 탄화 | `HF.H.ELEC.OHT`, `HF.H.ELEC.SCORCH` | ELEC |
| 절연/감전 | 감전, 전기, 누전, 절연, 피복 | `HF.H.ELEC.INS` | ELEC |
| 화학/유해물질 | 납, 프탈레이트, 냄새, 피부발진, 포름알데히드, 중금속 | `HF.H.CHEM` | CHEM |
| 구조/물리 | 깨짐, 파편, 날카로움, 모서리, 파손 | `HF.H.PHY.FRAC`, `HF.H.PHY.SHARP` | PHY |
| 삼킴/질식 | 삼킴, 소형부품, 자석, 단추 | `HF.H.PHY.SMALL`, `HF.H.PHY.MAG` | PHY |
| 끈/조임 | 끈, 코드, 목, 졸림, 매달림 | `HF.H.PHY.CORD` | PHY |
| 설계/구조 | 설계, 구조, 강도, 안정성, 전도 | `HF.M.DES` | M |
| 인증/불법 | 미인증, 무허가, 불법, KC없음, 미확인 | `HF.M.REG.ILLEGAL` | M |
| SW/알고리즘 | 오작동, 펌웨어, 업데이트, 센서, AI, 알고리즘 | `HF.H.SW`, `HF.S.ALGO` | H/S |

### G.2 DT 코드 키워드 매핑

| 키워드 그룹 | 키워드 예시 | 연결 DT 코드 |
|---|---|---|
| 화재/폭발 | 불, 화재, 폭발, 연소, 발화, 착화 | `DT.THERMAL.FIRE` |
| 화상 | 화상, 데임, 물집, 열상(열) | `DT.THERMAL.BURN` |
| 감전 | 감전, 전기, 쇼크, 찌릿 | `DT.ELECTRIC.SHOCK` |
| 질식/삼킴 | 삼킴, 질식, 기도, 호흡곤란 | `DT.ASPHYX.CHOKE` |
| 목조임 | 목, 졸림, 교액, 매달림 | `DT.ASPHYX.STRANG` |
| 중독 | 중독, 구토, 두통, 피부반응, 알레르기 | `DT.CHEMICAL.POISON` |
| 상해/부상 | 베임, 찔림, 끼임, 골절, 타박 | `DT.MECHANICAL.INJ` |
| 낙상 | 넘어짐, 전도, 떨어짐, 추락 | `DT.MECHANICAL.FALL` |
| 사망 | 사망, 숨짐 | `DT.BODY.DEATH` |

### G.3 복합 키워드 규칙

한 사고 개요에 복수 키워드 그룹이 감지될 때의 처리 규칙:

```
규칙 1: "폭발" + "화상" → HF.H.ELEC + DT.THERMAL.FIRE(Primary) + DT.THERMAL.BURN(Secondary)
규칙 2: "배터리" + "연기" + "그을음" → HF.H.ELEC.BAT + DT.THERMAL.FIRE 또는 HF.H.ELEC.SCORCH (심각도에 따라)
규칙 3: "자석" + "삼킴" + "복통" → HF.H.PHY.MAG + DT.ASPHYX.CHOKE(Primary) + DT.MECHANICAL.INJ(Secondary)
규칙 4: "미인증" + "감전" → HF.M.REG.ILLEGAL(Primary) + HF.H.ELEC.INS(Sub) + DT.ELECTRIC.SHOCK
```

> **[적용 기준]** 키워드 매칭만으로 분류할 경우 신뢰도를 0.6~0.7로 설정. 사고 개요의 문맥(맥락)까지 분석한 LLM 추론의 경우 0.7~0.9로 차등 적용. 신뢰도 0.8 미만은 조사관 필수 확인 대상.


---
<div style="page-break-before: always;"></div>

## 부록 H (참고) — 개발·운영 단계 실무 고려사항

본 부록은 코드 체계가 실제 시스템에 탑재된 이후, 지속 가능한 운영을 위해 개발팀·운영팀·현업 조사관이 미리 준비해야 할 네 가지 실무 사항을 정리한다.

---

### H.1 코드 마스터 테이블 거버넌스 (Data Governance)

#### 왜 필요한가?

분류 체계는 완성된 순간부터 변하기 시작한다. EU GPSR 이행세칙이 개정되거나, AI 소프트웨어 오작동처럼 기존 코드 체계에 없던 신종 위해요인이 등장하면 코드를 추가·수정해야 한다. 이때 절차 없이 코드를 임의로 추가하면 레거시(기존 엑셀파일 값) 데이터와 충돌하거나 통계가 깨진다.

> **[예시]** 도서관 분류번호(듀이십진법)가 바뀌면 기존 책의 위치가 모두 틀려지는 것과 같다. 사전에 규칙을 만들어 두지 않으면 분류 자체가 혼돈에 빠진다.

#### 코드 신설·변경 프로세스 (제언)

| 단계  | 내용                                              | 담당             |
| --- | ----------------------------------------------- | -------------- |
| 신청  | 변경 사유, 영향 범위, 매핑 대안 작성                          | 사업부(요청자)       |
| 검토  | 기존 코드와 중복 여부, 국제 표준(GPSR/OECD) 정합성 확인           | 시스템 담당 + 법규팀   |
| 승인  | 코드 신설 또는 Deprecate 결정                           | 시스템 책임자(Owner) |
| 적용  | DB `hf_codes` / `dt_codes` 마스터 테이블 갱신, 변경 이력 기록 | DBA            |
| 공지  | 변경 내용 현업 공유 (이메일 + 시스템 릴리즈 노트)                  | 시스템 담당         |

#### 하위 호환성(Backward Compatibility) 원칙

기존 코드를 **삭제하지 않는다**. 사용 중단 코드에는 `deprecated_at` 날짜를 기록하고 `is_active = FALSE`로 비활성화하여 이력 조회는 유지한다.

```sql
-- 마스터 테이블 권장 구조 (예시)
CREATE TABLE hf_codes (
    code          VARCHAR(30) PRIMARY KEY,   -- 예: HF.H.ELEC.BAT
    label_ko      TEXT        NOT NULL,
    label_en      TEXT,
    parent_code   VARCHAR(30) REFERENCES hf_codes(code),
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    effective_from DATE       NOT NULL DEFAULT CURRENT_DATE,
    deprecated_at  DATE,                    -- NULL이면 현행 유효
    change_reason  TEXT                     -- 변경 사유 (거버넌스 이력)
);
```

> **[정책]** *코드는 추가·비활성화만 허용하며, 물리적 삭제는 원칙적으로 금지한다.*

---

### H.2 AI 자동화(n8n) 환각(Hallucination) 통제 방안

#### 왜 필요한가?

LLM(대형 언어 모델)은 그럴듯하지만 틀린 코드를 자신있게 제안할 수 있다. AI가 "HF.H.ELEC.BAT"를 추천했는데 실제 사고 내용이 가스누출이라면, 담당자가 확인 없이 그대로 저장할 경우 통계 전체가 왜곡된다.

> **[예시]** 자동번역기가 번역을 해줘도 법률 문서는 담당자가 반드시 검토하는 것과 같다.

#### 권장 설계: 추론 근거(Reasoning) 필수 출력

n8n 워크플로우에서 LLM을 호출할 때, **분류 결과와 함께 추론 근거를 반드시 저장**하도록 설계한다.

```sql
-- incidents 테이블 AI 분류 관련 필드 (권장 추가)
ALTER TABLE incidents
    ADD COLUMN ai_hf_suggestion    VARCHAR(30),   -- AI 추천 HF 코드
    ADD COLUMN ai_dt_suggestions   TEXT[],        -- AI 추천 DT 코드 배열
    ADD COLUMN ai_reasoning        TEXT,          -- 추론 근거 (필수 저장)
    ADD COLUMN ai_confidence       NUMERIC(4,3),  -- 신뢰도 0.000~1.000
    ADD COLUMN ai_reviewed_by      INTEGER REFERENCES users(id),
    ADD COLUMN ai_reviewed_at      TIMESTAMPTZ,
    ADD COLUMN ai_decision         VARCHAR(10)    -- 'APPROVED' / 'MODIFIED' / 'REJECTED'
        CHECK (ai_decision IN ('APPROVED','MODIFIED','REJECTED'));
```

#### AI 추천 화면 UX 요구사항

담당 조사관이 AI 추천을 검토할 때 화면에 반드시 노출해야 할 항목:

| 표시 항목 | 예시 |
|---|---|
| AI 추천 코드 | `HF.H.ELEC.BAT` / `DT.THERMAL.FIRE`, `DT.NON-PHYS.PROP` |
| 추론 근거 (한국어) | "사고 내용에 '배터리 발화'가 명시되어 HF.H.ELEC.BAT(전기·배터리) 및 DT.THERMAL.FIRE(화재)로 분류함" |
| 신뢰도 | 87% |
| 조사관 최종 결정 | [승인] [수정 후 저장] [재분류] |

> **[정책]** *AI 추천은 반드시 조사관 승인을 거쳐야 하며, 추론 근거 없이 자동 저장하는 경로는 시스템에서 차단한다.*

---

### H.3 개발팀(백엔드·DBA)을 위한 DB 제약 조건 (Constraints) 요약

본 절은 PDR §4(데이터 모델)를 구현할 개발자가 놓치기 쉬운 제약 조건을 한곳에 모아 정리한다.

#### 필드별 제약 조건 체크리스트

| 필드 | 제약 조건 | 비고 |
|---|---|---|
| `hazard_factor_code` | `NOT NULL`, FK -> `hf_codes.code` | 모든 사고 건 필수 입력 |
| `damage_type_codes[]` | 배열 길이 >= 1 (`CHECK (array_length(...) > 0)`) | 최소 1개 DT 코드 필수 |
| `hf_sub` | `hazard_factor_code`가 `HF.L0.*` 또는 `HF.L1.*`일 때 `NOT NULL` | 인적요인 세분류 필수 |
| `product_name` | `NOT NULL`, `LENGTH > 0` | 공백만 입력 방지 |
| `incident_date` | `NOT NULL`, <= `CURRENT_DATE` | 미래 날짜 불가 |
| `ai_decision` | AI 추천 존재 시 `NOT NULL` | 미검토 건 저장 차단 |
| `hazard_factor_code` (마스터) | `is_active = TRUE`인 코드만 허용 | Deprecated 코드 신규 입력 차단 |

#### 트리거·CHECK 예시

```sql
-- DT 코드 배열 최소 1개 강제
ALTER TABLE incidents
    ADD CONSTRAINT chk_dt_min_one
    CHECK (array_length(damage_type_codes, 1) >= 1);

-- HF.L0/L1 선택 시 hf_sub 필수
ALTER TABLE incidents
    ADD CONSTRAINT chk_hf_sub_required
    CHECK (
        NOT (hazard_factor_code LIKE 'HF.L%')
        OR hf_sub IS NOT NULL
    );

-- Deprecated 코드 신규 입력 차단 (트리거)
CREATE OR REPLACE FUNCTION check_hf_code_active()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM hf_codes
        WHERE code = NEW.hazard_factor_code AND is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'HF 코드 %는 비활성(Deprecated) 상태입니다.', NEW.hazard_factor_code;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_hf_active
BEFORE INSERT OR UPDATE ON incidents
FOR EACH ROW EXECUTE FUNCTION check_hf_code_active();
```

> **[개발]** 제약 조건은 DB 레벨에서 1차로 막고, 애플리케이션 레벨(백엔드 API)에서 2차로 검증하는 **이중 방어(Defense in Depth)** 구조를 권장한다.

---

### H.4 현업 조사관 변화관리 (Change Management)

#### 왜 필요한가?

아무리 잘 설계된 분류 체계도 현장에서 외면받으면 소용없다. 기존에 '화재위험' 하나만 선택하던 조사관이 이제 HF 대분류 -> 중분류 -> 소분류 -> DT 코드를 순서대로 선택해야 한다면, 입력 피로도가 높아져 **"기타/미확인(`HF.UNKNOWN`)"** 남발 현상이 발생한다.

> **[예시]** 새 분리수거 기준이 도입될 때, 분리함 배치와 라벨만 잘 해놓아도 주민 참여율이 크게 달라지는 것과 같다.

#### 핵심 대응 전략: "검색 한 번으로 끝나게"

조사관이 기존 업무 용어(예: "배터리")를 검색창에 입력하면 관련 코드가 즉시 필터링되어야 한다. 이를 위해 **코드 마스터 테이블에 검색 태그(search_tags) 필드**를 별도로 관리한다.

```sql
-- hf_codes 마스터에 검색 태그 추가
ALTER TABLE hf_codes
    ADD COLUMN search_tags TEXT[];   -- 예: ARRAY['배터리','리튬','발화','충전']

-- 조사관 검색 쿼리 예시: "배터리" 입력 시
SELECT code, label_ko
FROM   hf_codes
WHERE  is_active = TRUE
  AND  (
       label_ko ILIKE '%배터리%'
    OR EXISTS (
         SELECT 1 FROM unnest(search_tags) t
         WHERE t ILIKE '%배터리%'
       )
  )
ORDER BY code;
-- 결과: HF.H.ELEC.BAT (전기·배터리), HF.H.ELEC.CHARGE (충전기 결함) 등
```

#### 도입 초기 지원 방안

| 항목                       | 내용                                                    |
| ------------------------ | ----------------------------------------------------- |
| 코드 매핑 Quick Reference 카드 | 레거시(기존 엑셀파일 값) 용어 <-> 신규 HF/DT 코드 1:1 대조표 배포 (1장 인쇄물) |
| 자동완성 UI                  | 키워드 입력 -> 관련 HF/DT 코드 드롭다운 즉시 표시 (§H.4 검색 태그 활용)      |
| AI 초안 제공                 | 사고 내용 입력 시 AI가 코드 초안을 미리 채워두어 조사관은 확인·승인만 수행          |
| 초기 3개월 집중 교육             | 팀별 소규모 교육(30분), FAQ 문서 배포, 슬랙/이메일 문의 채널 운영            |
| 오류 피드백 루프                | 조사관이 "이 코드가 맞지 않는다"고 표시하면 거버넌스 프로세스(§H.1)로 자동 연결      |

> **[정책]** *"코드가 더 많아졌지만, 검색 한 번이면 찾을 수 있습니다. AI가 초안을 잡아드리니 여러분은 확인만 하시면 됩니다."*

---

<div style="page-break-before: always;"></div>


## 부록 I (참고) — 국제 표준 연계 및 리스크평가


### I.1 해외 주요 시스템의 분류 체계 현황

#### I.1.1 OECD GlobalRecalls 포털

46개 참여국, 27,000건+ 리콜 정보를 단일 플랫폼으로 통합. EU Safety Gate 및 ASEAN 리콜 포털 데이터를 자동 연동.

- **제품 분류 기준**: GS1 GPC(Global Product Classification) 표준 채택
- **위해 정보 구조**: `hazard_description`(원인)과 `consumer_risk`(소비자 위험)를 **별도 필드**로 구분 운용

> **[비고]** OECD 포털은 ISO 5665와 마찬가지로 원인-결과를 이중 필드로 분리. 본 HF/DT 이중 코드 체계와 구조적으로 정합.

#### I.1.2 EU Safety Gate (구 RAPEX)

EU 31개국 비식품 위험 제품 신속 정보 교환 시스템. 2024년 4,237건(역대 최고치). EU GPSR (EU) 2023/988이 2024년 12월 13일 발효.

**공식 위험 유형(Type of Risk) 분류**:

| # | 위험 유형 | 한국어 | 2024 비율 |
|:---:|---|:---:|:---:|
| 1 | **Chemical** | 화학적 위험 | 49% |
| 2 | **Injuries** | 상해 | 14% |
| 3 | **Environmental** | 환경 위험 | 8% |
| 4 | **Electric Shock** | 감전 | 7% |
| 5 | **Choking** | 질식(삼킴) | 7% |
| 6~11 | Fire, Strangulation, Drowning, Damage to hearing/sight, Property damage, Energy resources | — | — |

> **[비고]** '피해(harm)'의 정의를 신체 부상에서 **정신적 영향·경제적 손실·동물·환경**까지 확장. v0.4에서 DT.NON-PHYS.PSYCH·DT.NON-PHYS.ECON 신규 추가.

### I.2 국제 리스크평가 프레임워크 연계

#### I.2.1 공통 리스크 공식

```
Risk(위험도) = Severity(심각도) × Probability(발생확률)
```

마치 독약(Severity)이라도 철저히 잠긴 창고에 있으면(Probability↓) 실제 위험도는 낮고, 약한 독(Severity↓)이라도 아이 손에 쉽게 닿는다면(Probability↑) 위험도가 높아지는 원리.

#### I.2.2 참고 문서별 분류 체계 기여

| 문서 | 발행기관/연도 | 분류체계에 주는 시사점 |
|---|---|---|
| **PRISM v2.0** | 영국 OPSS, 2024 | Risk 4단계(Low/Medium/High/Serious), 심리적·경제적 피해 포함, 취약계층 별도 고려 |
| **CENELEC Guide 32** | EU, 2014 | 위해요인을 **기원(origin)**과 **성질(nature)** 두 축으로 분류 → HF/DT 분리의 근거 |
| **EU 2019/417 (RAPEX)** | EU 집행위, 2018 | 리콜 조치 8단계 계층 확정, 심각/경미 위험 구분 기준 |
| **ISO 12100:2010** | ISO, 2010 | "합리적으로 예견 가능한 오용" 개념 → L0/L1 코드 유지의 이론적 근거 |
| **RIVM Toy (2008)** | 네덜란드 RIVM | 화학물질 노출경로 6가지, 연령별 노출 특성 → HF.H.CHEM 소분류 설계 참조 |
| **METI RA Handbook** | 일본 경제산업성, 2011 | 심각도 5단계(Fatal~Negligible), 리스크 어세스먼트 실무 가이드 → §6.2 심각도 측정 기준 참조 |

#### I.2.3 HF·DT·리스크평가 연계 흐름

```
[분류 체계 영역]          [리스크평가 영역]          [리스크관리 영역]

HF 코드 ──────────┐                                ┌── 리콜 결정
(원인 식별)        │     Risk = Severity ×         │
                  ├──→  Probability          ──→  ├── 경고 발령
DT 코드 ──────────┤                                │
(결과 식별)        │   Severity: DT 코드 기반      └── 판매 중지
                  │   Probability: 제품 출하량
ISO 5665          │                    노출 인구
Severity(0~5) ────┘
```

### I.3 리스크 등급 연계 체계

PRISM v2.0(2024) 4단계 Risk Level을 DT 코드 및 ISO 5665:2024 Severity(0~5)에 연계:

```
ISO 5665:2024    PRISM v2.0 Risk Level    DT 코드 기본 대응 (예시)
─────────────────────────────────────────────────────────────────
Severity 5       Serious                  DT.BODY.DEATH, DT.ASPHYX.DROWN, DT.THERMAL.FIRE
Severity 4       Serious / High           DT.THERMAL.FIRE, DT.ELECTRIC.SHOCK
Severity 3       High                     DT.ASPHYX.CHOKE, DT.ASPHYX.STRANG, DT.THERMAL.BURN
Severity 2       Medium                   DT.MECHANICAL.INJ, DT.CHEMICAL.POISON, DT.THERMAL.BURN
Severity 1       Low                      DT.BODY.SENSE, DT.MECHANICAL.FALL, DT.NON-PHYS.PSYCH
Severity 0       Low                      DT.OTHER.NEARMI, DT.NON-PHYS.ECON
```

> **[주의]** Risk Level은 Severity(DT 코드 기반)와 Probability(출하량·노출 인구 기반)를 조합해 최종 산출. 위 표는 Severity 측면의 기본값.

**PRISM v2.0 리스크 프로세스와 시스템 연계**:

| PRISM 단계 | 시스템 연계 작업 |
|---|---|
| 1. 비준수 제품 식별 | 리콜 접수 → HF + DT 코드 입력 |
| 2. 리스크 트리아지 | DT 코드의 Severity 참조하여 전면 평가 여부 결정 |
| 3. 리스크 평가 (Severity × Probability) | 시스템 리스크 평가 모듈 (향후 개발) |
| 4. 리스크 평가 결과 검토 | 담당자 검토·승인 |
| 5. QA 및 기록 | 시스템 DB 저장 + OPSS/Safety Gate 보고 |
| 6. 리스크 관리 (리콜·경고·금지) | 행정 조치 연계 |

---
<div style="page-break-before: always;"></div>

## 부록 J (참고) — 변경 이력

| 버전   | 섹션             | 변경 내용                                                      | 근거                   |
| ---- | -------------- | ---------------------------------------------------------- | -------------------- |
| v0.1 | 전체             | 초기 리콜 원인 분류 코드 체계 초안                                       | 내부 요구                |
| v0.2 | §2             | HF/DT 이중 코드 체계 도입, 17개 HF 코드                               | 사용자 요청               |
| v0.3 | §2             | DT 코드 14개로 확장, 해외 사례 추가                                    | 사용자 요청               |
| v0.4 | §0 (신규)        | CEO 요약 페이지: 현황→문제→해결 다이어그램, 코드 약어 사전, 3개 통계 연계 구조          | 사용자 요청               |
| v0.4 | §1.4 (신규)      | 국제 리스크평가 프레임워크 5종 연계                                       | 리스크평가 참고자료 분석        |
| v0.4 | §2.1           | HF 점(.) 표기 확정, DT 하이픈 유지, v0.3→v0.4 대응표                    | 사용자 확정               |
| v0.4 | §2.2           | HF 코드 전면 재설계: M-SHELL 6요소 대분류 체계 (총 30개)                   | 사용자 확정               |
| v0.4 | §2.3           | DT.NON-PHYS.PSYCH·DT.NON-PHYS.ECON 신규 추가 (총 16개)                             | PRISM v2.0·GPSR 2024 |
| v0.4 | §2.5 (신규)      | PRISM v2.0 Risk Level ↔ DT코드·ISO5665 Severity 매핑           | 리스크평가 통합             |
| v0.4 | §0.2 (신규)      | HF/DT Full Name 표, 이중 분류 필요성 설명                            | CEO 이해도 제고           |
| v0.4 | §0.4 (신규)      | L0·L1 Liveware 개념 설명, 항공 비유, 단독 사용 금지 원칙                   | CEO 이해도 제고           |
| v0.4 | §2.2.5~6       | Liveware 어원(Elwyn Edwards), 조종사·관제사 비유                     | L0·L1 개념 강화          |
| v0.4 | 부록 C (신규)      | 사고조사 대장 엑셀 적용 예시 — 5개 사례, 엑셀 수식                            | 실무 적용 지원             |
| v0.5 | 전체             | ISO/KS 규격 문서 형식으로 전체 재구성 (§0 CEO 요약 제외)                    | 사용자 요청               |
| v0.5 | §0.4           | L0·L1 제외 설명을 실무 맥락(제품위해정보분류시스템 드롭다운)으로 풀어 작성               | 사용자 요청               |
| v0.5 | §0.5           | CEO 요약에는 대분류 6행만 유지, 중분류·소분류는 부록 B로 이동                     | 사용자 요청               |
| v0.5 | 부록 A (신규)      | DB 스키마 변경 방안                                               | 사용자 요청               |
| v0.5 | 부록 B (신규)      | HF·DT 전체 코드 목록 대분류별 그룹 (구 §0.5 중분류·소분류 이동)                 | 사용자 요청               |
| v0.5 | 부록 G (신규)      | n8n 워크플로우 연계 방안                                            | 사용자 요청               |
| v0.5 | 부록 E (신규)      | 개발 로드맵 (구 §3 이동)                                           | 사용자 요청               |
| v0.5 | 부록 G·H         | 변경 이력·참조 출처 재정렬                                            | 규격 문서 형식 적용          |
| v0.5 | 부록 F·H (구 G·H) | 변경이력·참조출처 재정렬 (부록 순서 조정에 따른 레터 변경)                         | 사용자 요청               |
| v0.6 | §3.7, §0.7     | PIIMS → 제품위해정보분류시스템, §5.8 삭제, §7.3 GPC → 부록 H 이동, 버전 주석 제거 | 사용자 요청               |
| v0.6 | 부록 A·B         | 신규 부록 통합 및 구조 보완                                           | 사용자 요청               |
| v0.7 | §3.7           | PHICS 약어 추가, 정의 재작성                                        | 사용자 요청               |
| v0.7 | §6.2           | EU Safety Gate Type of Risk 표 한국어 열 추가                     | 사용자 요청               |
| v0.7 | §7.3           | HF·DT 교차 분석 SQL 쿼리 3종, 단일·이중 코드 비교표, 패널 설계 추가              | 사용자 요청               |
| v0.7 | 전체             | 레거시 → 레거시(기존 엑셀파일 값) 병기                                    | 사용자 요청               |
| v0.7 | 부록 E           | 향후 계획 → 개발 로드맵 제목 변경, E.2 추진 리스크 명칭 변경                     | 사용자 요청               |
| v0.7 | 부록 순서          | C(n8n)→G, D(사고조사)→C, E(참조)→D, F(로드맵)→E, G(이력)→F 재배열        | 사용자 요청               |
| v0.7 | 목차             | §0.TOC 목차 페이지 신규 추가                                        | 사용자 요청               |
| v0.8 | 부록 I (신규)      | 개발·운영 단계 실무 고려사항 (거버넌스, AI 환각 통제, DB 제약, 변화관리)             | 사용자 요청               |
| v0.8.1 | 전체           | 날짜 오류 수정, 부록 참조 링크 정비                                      | 내부 검토                |
| v0.9 | §4.2           | DT 코드 계층화: `DT-FIRE` → `DT.THERMAL.FIRE` 점(.) 표기, 7개 중분류 도입 | 사용자 요청               |
| v0.9 | §5.1.1         | HF.H.ELEC.SCORCH(비화재 열적 사고) 신규 추가                           | 사용자 요청               |
| v0.9 | §5.1.4 (신규)    | HF.H.SW(소프트웨어/펌웨어 위해) 중분류 신설: ALGO/FW/UPDATE               | 사용자 요청               |
| v0.9 | §5.2           | HF.S.STD deprecated → 8개 세분화 코드(INTL/NATL/CORP×ABS·DEF, INFO, ALGO) | 사용자 요청               |
| v0.9 | §5.3           | HF.M.DES 정의 수정, HF.M.REG.ILLEGAL·UNMANAGED·VIOL 신규 추가       | 사용자 요청               |
| v0.9 | §5.5           | HF.L0.MISUSE 명칭 변경(일반소비자), ELDERLY·DISABLED 신규 추가            | PRISM v2.0 취약계층 반영   |
| v0.9 | §8.4 (신규)      | 심각도 산출 최악 시나리오 우선 원칙 명문화, ISO 5665+METI 5단계 통합 정의         | ISO 12100·EU 2019/417·METI |
| v0.9 | 부록 A           | Primary/Secondary DT 필드, 최악 시나리오 심각도 필드, DT 마스터 dt_group 추가 | 사용자 요청               |
| v0.9 | 부록 A.4 (신규)    | 레거시 DT 코드 매핑 테이블 (하이픈→점 계층)                                | DT 계층화 마이그레이션        |
| v0.9 | 부록 B           | B.2 HF.H 소분류 목록 삭제(§5와 중복), B.2 DT 중분류 그룹 목록으로 대체          | 사용자 요청               |
| v0.9 | 부록 D           | METI 리스크 어세스먼트 핸드북 참조 추가                                    | 사용자 요청               |
| v0.9 | 부록 J (신규)      | AI 분류 학습용 키워드 사전                                            | 사용자 요청               |
| v0.9.1 | 전체           | v0.9 검수 — 부록 레터 오류 수정, 누락 참조 보완                              | 내부 검토                |
| v0.9.2 | §5.6          | HF.L1.SELLER deprecated → MFR/IMP/AGENT/DIST/RETAIL 5개 세분화  | 사용자 요청               |
| v0.9.2 | §6.1          | DT 코드 목록을 8개 중분류별 소절(6.1.1~6.1.8)로 분리, 가독성 제고               | 사용자 요청               |
| v0.9.2 | §6.2 (신규)     | 심각도 측정 기준 신설: ISO 5665+METI+EU 2019/417 통합 6단계 정의, 부록 C 연계 | METI·EU 2019/417      |
| v0.9.2 | §6.3          | 심각도 산출 최악 시나리오 원칙을 구 §8.4에서 §6.3으로 이동                       | 구조 정비                |
| v0.9.2 | §6.4          | EU Safety Gate 매핑을 구 §6.2에서 §6.4로 번호 조정                     | 구조 정비                |
| v0.9.2 | §8 → 부록 J     | §8(국제 표준 연계 및 리스크평가)를 부록 J(참고)로 이동                           | 사용자 요청               |
| v0.9.2 | 부록 순서         | 부록 재정렬: H=AI키워드, I=실무, J=국제표준, K=변경이력                        | 사용자 요청               |
| v0.9.2 | 전체 (46건)      | blockquote `>` 라벨 표준화: [비고]/[예시]/[주의]/[적용 기준]/[정책]/[참조]/[개발] | 사용자 요청               |
| v0.9.3 | 전체           | 문서 내부 정비 (날짜·참조 보완)                                                                         | 내부 검토                |
| v0.9.4 | 목차·부록       | 부록 B(HF·DT 전체 코드 목록) 본문 §5·§6 중복으로 삭제; 부록 레터 재정렬(구 C-K → B-J)                           | 사용자 요청               |
| v0.9.5 | YAML·본문 헤더  | frontmatter 버전 불일치 수정(v0.9.3 → v0.9.5); 작성일 2026-03-09 → 2026-03-10                        | 내부 검토                |
| v0.9.5 | §0.3          | DT 코드 설명 표현 개선: "v0.9 계층화" → "v0.9에서 점(.) 계층 표기로 전환"                                     | 내부 검토                |
| v0.9.5 | §0.5          | 삭제된 부록 B(HF·DT 코드 목록) 참조를 §5·§6 직접 참조로 수정; Obsidian 링크 제거                               | 내부 검토                |
| v0.9.5 | §0.6          | DT 중분류 수량 오류 수정 (7개 → 8개); 심각도 척도 §6.2.1 상호 참조 추가                                       | 내부 검토                |
| v0.9.5 | §1.2          | 부록 참조 번호 수정 (부록 C → 부록 B, 사고조사 대장)                                                        | 내부 검토                |
| v0.9.5 | §3.3          | M-SHELL 나열 순서 기준 명시 주석 추가 (약어 순 vs §0.5 비중 순)                                             | 내부 검토                |
| v0.9.5 | §4.2          | deprecated 중분류 코드 정비: STD·SELLER 제거, MFR/IMP/AGENT/DIST/RETAIL 추가                            | 내부 검토                |
| v0.9.5 | §6.2.1        | AI 생성 [cite_start] 잔류 태그 및 [cite: …] 번호 제거; 부록 C → 부록 B 참조 수정                           | 내부 검토                |
| v0.9.5 | §7.1          | deprecated `HF.S.STD` → `HF.S.QC`, `HF.S.PROC`, `HF.S.NATL.DEF` 교체                              | 내부 검토                |
| v0.9.5 | §7.2          | 리콜 사례 표 `HF.S.STD` → `HF.S.NATL.DEF` 교체 (전기청소기 안전기준 미준수 사례)                             | 내부 검토                |
| v0.9.5 | §7.3          | SQL 예시 유효하지 않은 `HF.H.MECH.OVL` → `HF.H.ELEC.OHT` 교체; "1부록 A" 오타 → "부록 A" 수정            | 내부 검토                |
| v0.9.5 | 부록 B         | 섹션 번호 오류 수정 (C.4 → B.4)                                                                        | 내부 검토                |
| v0.9.5 | 부록 B.3       | DT 심각도 기본값 불일치 수정: DT.BODY.SENSE, DT.MECHANICAL.FALL 2 → 1 (§6.2.2와 통일)                   | 내부 검토                |
| v0.9.5 | 부록 D.1       | HF 코드 총 수량 업데이트 (30개 → 50개); n8n 워크플로우 참조 수정 (부록 F → 부록 E)                             | 내부 검토                |
| v0.9.5 | 부록 G         | n8n 워크플로우 교차 참조 오류 수정 (부록 F → 부록 E)                                                       | 내부 검토                |
| v0.9.5 | 부록 H         | 내부 섹션 번호 오류 수정 (I.3 → H.3, I.4 → H.4); 교차 참조 수정 (§I.4 → §H.4, §I.1 → §H.1)            | 내부 검토                |

---

<div style="page-break-before: always;"></div>

