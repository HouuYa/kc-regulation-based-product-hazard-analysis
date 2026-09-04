# Humanize Korean Skill — 설치 안내

> **버전**: v1.6.1-gov (Claude.ai 포팅 + 정부문서 K 카테고리)
> **원본**: epoko77-ai/im-not-ai (MIT License)

---

## 파일 구조

```
humanize-korean/
├── SKILL.md                    ← 스킬 핵심 지침 (Claude가 읽는 파일)
├── references/
│   ├── quick-rules.md          ← Fast 모드 S1/S2 패턴 룰북
│   ├── gov-patterns.md         ← 정부·행정 문서 K 카테고리 (커스텀)
│   ├── project-terms.md        ← KC 프로젝트 권장·보호 용어
│   ├── project-preservation.md ← 수치·코드·책임 주체 보존 규칙
│   └── taxonomy-compact.md     ← Strict 모드 전체 60+ 패턴 요약
└── scripts/
    └── metrics.py              ← 정량 점수 계산 (Python 표준 라이브러리)
```

---

## 설치 방법 (Claude.ai 스킬 시스템)

### 방법 1: 폴더 통째로 복사

```bash
cp -r /home/claude/humanize-korean/ /path/to/your/skills/user/
```

### 방법 2: Claude Desktop 연동

1. Claude Desktop → Settings → Skills 탭
2. `humanize-korean` 폴더 통째로 드래그 앤 드롭
3. 재시작 후 스킬 활성화 확인

---

## 트리거 키워드

다음 중 하나가 감지되면 자동 활성화:

- `AI 티 없애줘` / `AI 냄새 없애줘`
- `번역투 제거` / `GPT 문체 제거`
- `사람이 쓴 것처럼 윤문해줘`
- `자연스럽게 고쳐줘`
- `한글 AI 윤문`
- `공문서 번역투 제거` / `행정 문체 교정`
- `판단됨 표현 고쳐줘` / `예정임 다듬어줘`
- `보고서 문체 자연스럽게`

---

## 사용 예시

### 기본 사용 (텍스트 직접 붙여넣기)

```
AI 티 없애줘:

AI 기술을 통해 효율을 높일 수 있을 것으로 판단됩니다.
또한, 이에 따라 추진해 나갈 예정임을 알 수 있다.
```

### 장르·강도 지정

```
사람이 쓴 것처럼 윤문해줘.
장르: 정부보고서
강도: 표준

[텍스트]
```

### Strict 모드

```
번역투 제거 --strict

[8,000자 이상 장문 텍스트]
```

### KC안전기준 프로젝트 문구

화면 문구는 `UI 모드`, 운영 알림은 `운영알림 모드`, 00·01 설계문서와 구현 이력은
`설계문서 모드`로 처리합니다. `HF/DT`, 조항번호, 수치·단위·날짜, URL·명령어,
상태값, 법령 인용, 담당자와 시스템의 책임 주체는 윤문 전후에 보존하는지 확인합니다.

프로젝트 참고 규칙은 `references/project-terms.md`와
`references/project-preservation.md`에 있습니다.

### 재윤문 요청

```
행정 문체만 다시 고쳐줘 (K 카테고리)
번역투만 더 손봐줘 (A 카테고리)
강도 낮춰줘
```

---

## metrics.py 직접 실행

```bash
# 파일로 비교
python scripts/metrics.py \
  --original-file original.txt \
  --revised-file revised.txt

# 텍스트 직접 입력
python scripts/metrics.py \
  --original "원문 텍스트" \
  --revised "윤문본 텍스트"

# JSON 출력 (자동화 연동용)
python scripts/metrics.py \
  --original-file original.txt \
  --revised-file revised.txt \
  --json
```

JSON 결과에는 `preservation.ok`와 변경된 보호 토큰 목록이 포함됩니다. 보호 토큰이
달라지면 문체가 자연스러워져도 사용자 확인이 필요합니다.

---

## 등급 기준

| 등급 | 조건 |
|------|------|
| **A** | S1 잔존 0건, S2 ≤2건, 변경률 <50%, 개선률 70%+ |
| **B** | S1 잔존 0건, S2 ≤4건, 변경률 <50% |
| **C** | S1 1~2건 잔존 또는 변경률 ≥50% → 재윤문 제안 |
| **D** | S1 3건+ 또는 심각한 과윤문 → 사용자 검토 요청 |

---

## v2.0 업그레이드 예정 항목

- `references/taxonomy-compact.md`에 한국 번역학계 8유형 패턴 추가
  - A-16~A-19 (관계대명사 직역, 이중 조사 결합 등)
  - E-7 (청자 경어법 일관성)
- `scripts/metrics.py`에 interference_index (E-1 리듬 균일 지표) 추가
- Canvas 아티팩트에 패턴 분포 히트맵 추가
