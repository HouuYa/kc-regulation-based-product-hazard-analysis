#!/usr/bin/env python3
"""
metrics.py — Humanize Korean 정량 점수 계산기
출처: epoko77-ai/im-not-ai v1.6.1 metrics.py 기반 Claude.ai 포팅
표준 라이브러리만 사용 (외부 패키지 불필요)

사용법:
  python metrics.py --original-file original.txt --revised-file revised.txt
  python metrics.py --original "원문 텍스트" --revised "윤문본 텍스트"
  python metrics.py --original-file original.txt --revised-file revised.txt --json
"""

import argparse
import json
import re
import sys
from difflib import SequenceMatcher


# ─────────────────────────────────────────────
# S1 패턴 탐지 (결정타 — 0건 목표)
# ─────────────────────────────────────────────
S1_PATTERNS = [
    # C-11: 연결어미 뒤 쉼표 (최강 신호)
    ("C-11", re.compile(r"(하지만|그러나|따라서|또한|결국|즉|그리고|하여|되어|며),\s")),
    # A-1: ~를 통해
    ("A-1",  re.compile(r"을\s*통해|를\s*통해")),
    # A-3: ~에 있어서
    ("A-3",  re.compile(r"에\s*있어서|에\s*있어\s")),
    # A-4: 이중 피동
    ("A-4",  re.compile(r"되어\s*진|되어지고")),
    # D-1: 결론적으로 문두
    ("D-1",  re.compile(r"(^|。|\.|\n)\s*결론적으로[,，]?\s", re.MULTILINE)),
    # D-2: 시사하는 바가 크다
    ("D-2",  re.compile(r"시사하는\s*바가?\s*크다|시사하는\s*바가?\s*있다")),
    # D-5: ~임을 알 수 있다
    ("D-5",  re.compile(r"임을\s*알\s*수\s*있다|음을\s*알\s*수\s*있다|를\s*알\s*수\s*있다")),
    # G-1: 다중 완곡
    ("G-1",  re.compile(r"수\s*있을\s*것으로\s*보인다|것\s*같다|것으로\s*사료된다")),
    # H-1: 또한 문두 반복 (2회 이상은 별도 카운트)
    ("H-1",  re.compile(r"(^|。|\.\s|\n)\s*또한[,，]?\s", re.MULTILINE)),
    # A-2: ~에 대한 밀도 (단락 100자당 2회 이상)
    ("A-2",  re.compile(r"에\s*대한|에\s*대해서?")),
    # K-1: 것으로 판단됨
    ("K-1",  re.compile(r"것으로\s*판단됨|것으로\s*판단됩니다|것으로\s*사료됨|것으로\s*파악됨|것으로\s*확인됨")),
    # K-2: 추진할 예정임 과잉
    ("K-2",  re.compile(r"추진해?\s*나갈\s*예정|추진할\s*계획을\s*가지고")),
    # K-3: 필요성 과잉
    ("K-3",  re.compile(r"필요성이\s*대두되고\s*있|중요성이\s*강조되고\s*있는\s*상황")),
]

# ─────────────────────────────────────────────
# S2 패턴 탐지 (누적 시 AI 신호)
# ─────────────────────────────────────────────
S2_PATTERNS = [
    ("A-5",  re.compile(r"가지고\s*있다|갖고\s*있다")),
    ("A-6",  re.compile(r"함으로써|함으로서")),
    ("A-7",  re.compile(r"논의를\s*하다|검토를\s*하다|활용을\s*하다|분석을\s*하다")),
    ("A-8",  re.compile(r"진행하고\s*있다|추진하고\s*있다|연구하고\s*있다")),
    ("A-9",  re.compile(r"로\s*인하여|로\s*인해")),
    ("A-10", re.compile(r"의\s*경우[에는]?")),
    ("C-12", re.compile(r",")),   # 쉼표 밀도는 별도 계산
    ("D-3",  re.compile(r"주목할\s*만하다|주목할\s*만한|주목됩니다")),
    ("D-4",  re.compile(r"혁신적인|획기적인|선도적인")),
    ("D-7",  re.compile(r"중요한\s*역할을\s*한다|핵심적인\s*역할을")),
    ("D-8",  re.compile(r"다양한")),
    ("G-2",  re.compile(r"라고\s*할\s*수\s*있다|다고\s*할\s*수\s*있다")),
    ("H-2",  re.compile(r"(^|。|\.\s|\n)\s*따라서[,，]?\s", re.MULTILINE)),
    ("H-3",  re.compile(r"이에\s*따라|이를\s*통해")),
    ("I-1",  re.compile(r"것이다\.")),
    ("I-4",  re.compile(r"할\s*필요가\s*있다|할\s*필요성이\s*있다")),
    ("K-4",  re.compile(r"검토할\s*필요가\s*있|면밀히\s*검토할\s*필요")),
    ("K-5",  re.compile(r"있는\s*실정임|있는\s*상황임|추세를\s*보이고\s*있")),
    ("K-7",  re.compile(r"지속적으로\s*추진해\s*나갈|단계적으로\s*확대해\s*나갈")),
    ("K-8",  re.compile(r"해\s*드리도록\s*하겠습니다|시행하도록\s*하겠습니다")),
]

# 프로젝트 문구의 의미를 좌우하는 보호 토큰. 숫자와 코드는 문체보다 우선한다.
PROTECTED_PATTERNS = [
    ("number", re.compile(r"(?<![A-Za-z])\d+(?:[,.]\d+)*(?:\.\d+)?")),
    ("code", re.compile(r"\b(?:HF|DT)\.[A-Z0-9_.-]+|\b(?:[A-Z][A-Z0-9_]*)(?:_[A-Z0-9]+)+\b")),
    ("status", re.compile(r"\b(?:approved|auto_unreviewed|rejected|pending|confirmed|error)\b")),
    ("url", re.compile(r"https?://[^\s)]+|/api/[A-Za-z0-9_./\[\]-]+")),
    ("command", re.compile(r"npm run [A-Za-z0-9:_-]+(?: -- --?[A-Za-z0-9_-]+)?")),
    ("env", re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")),
]


def count_patterns(text: str, patterns: list) -> dict:
    """패턴 ID → 매치 수 딕셔너리 반환"""
    counts = {}
    for pid, pattern in patterns:
        matches = pattern.findall(text)
        if matches:
            counts[pid] = len(matches)
    return counts


def calc_comma_density(text: str) -> float:
    """100자당 쉼표 수"""
    if not text:
        return 0.0
    chars = len(text.replace(" ", "").replace("\n", ""))
    commas = text.count(",") + text.count("，")
    return round(commas / max(chars, 1) * 100, 2)


def calc_change_rate(original: str, revised: str) -> float:
    """변경률 = 1 - 유사도 (0~100%)"""
    if not original:
        return 0.0
    ratio = SequenceMatcher(None, original, revised).ratio()
    return round((1 - ratio) * 100, 1)


def calc_sentence_length_variance(text: str) -> float:
    """문장 길이 표준편차 (높을수록 리듬 다양 = AI 신호 낮음)"""
    sentences = re.split(r"[.。!?！？\n]+", text)
    lengths = [len(s.strip()) for s in sentences if len(s.strip()) > 5]
    if len(lengths) < 3:
        return 0.0
    mean = sum(lengths) / len(lengths)
    variance = sum((l - mean) ** 2 for l in lengths) / len(lengths)
    return round(variance ** 0.5, 1)


def grade(s1_count: int, s2_count: int, change_rate: float) -> str:
    """등급 판정 A/B/C/D"""
    if s1_count == 0 and s2_count <= 2 and change_rate < 50:
        return "A"
    elif s1_count == 0 and s2_count <= 4 and change_rate < 50:
        return "B"
    elif s1_count <= 2 or change_rate >= 50:
        return "C"
    else:
        return "D"


def improvement_rate(before_s1: int, after_s1: int,
                     before_s2: int, after_s2: int) -> float:
    """패턴 개선률 (탐지 패턴 감소 비율)"""
    before_total = before_s1 * 2 + before_s2   # S1 가중치 2배
    after_total = after_s1 * 2 + after_s2
    if before_total == 0:
        return 100.0
    return round((1 - after_total / before_total) * 100, 1)


def protected_tokens(text: str) -> dict:
    """보존해야 하는 프로젝트 토큰을 종류별로 추출한다."""
    return {
        kind: sorted(pattern.findall(text))
        for kind, pattern in PROTECTED_PATTERNS
    }


def preservation_check(original: str, revised: str) -> dict:
    """보호 토큰이 윤문 전후에 동일한지 확인한다."""
    before = protected_tokens(original)
    after = protected_tokens(revised)
    changed = {
        kind: {"before": before[kind], "after": after[kind]}
        for kind in before
        if before[kind] != after[kind]
    }
    return {"ok": not changed, "changed": changed}


def analyze(text: str) -> dict:
    """단일 텍스트 분석"""
    s1_counts = count_patterns(text, S1_PATTERNS)
    s2_counts = count_patterns(text, S2_PATTERNS)
    s1_total = sum(s1_counts.values())
    s2_total = sum(s2_counts.values())
    comma_density = calc_comma_density(text)
    sent_variance = calc_sentence_length_variance(text)

    # C-12 쉼표 밀도 S2 보정 (100자당 3개 이상)
    c12_flag = comma_density >= 3.0

    return {
        "s1_total": s1_total,
        "s2_total": s2_total + (1 if c12_flag else 0),
        "s1_detail": s1_counts,
        "s2_detail": s2_counts,
        "comma_density": comma_density,
        "c12_high_density": c12_flag,
        "sentence_variance": sent_variance,
        "char_count": len(text),
    }


def run(original: str, revised: str, as_json: bool = False):
    before = analyze(original)
    after = analyze(revised)
    change_rate = calc_change_rate(original, revised)
    improve = improvement_rate(
        before["s1_total"], after["s1_total"],
        before["s2_total"], after["s2_total"]
    )
    g = grade(after["s1_total"], after["s2_total"], change_rate)
    preservation = preservation_check(original, revised)

    result = {
        "grade": g,
        "change_rate_pct": change_rate,
        "improvement_pct": improve,
        "before": {
            "s1_total": before["s1_total"],
            "s2_total": before["s2_total"],
            "comma_density": before["comma_density"],
            "sentence_variance": before["sentence_variance"],
            "s1_detail": before["s1_detail"],
        },
        "after": {
            "s1_total": after["s1_total"],
            "s2_total": after["s2_total"],
            "comma_density": after["comma_density"],
            "sentence_variance": after["sentence_variance"],
            "s1_detail": after["s1_detail"],
        },
        "warnings": [],
        "preservation": preservation,
    }

    # 경고 생성
    if change_rate >= 50:
        result["warnings"].append(f"과윤문 경고: 변경률 {change_rate}% (상한 50%)")
    elif change_rate >= 30:
        result["warnings"].append(f"변경률 {change_rate}% — 검토 권장 (권고 상한 30%)")
    if after["s1_total"] > 0:
        result["warnings"].append(f"S1 패턴 {after['s1_total']}건 잔존: {list(after['s1_detail'].keys())}")
    if g == "C" or g == "D":
        result["warnings"].append(f"등급 {g} — 재윤문 또는 사용자 검토 권장")
    if not preservation["ok"]:
        result["warnings"].append("보호 토큰 변경: 수치·코드·URL·명령어·상태값을 사용자 확인")

    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        _print_report(result)

    return result


def _print_report(r: dict):
    """사람이 읽기 좋은 텍스트 리포트"""
    print("=" * 50)
    print(f"  Humanize Korean 점수 리포트")
    print("=" * 50)
    print(f"  등급        : {r['grade']}")
    print(f"  변경률      : {r['change_rate_pct']}%")
    print(f"  개선률      : {r['improvement_pct']}%")
    print(f"  보존 검사   : {'통과' if r['preservation']['ok'] else '확인 필요'}")
    print()
    print("  [탐지 패턴]   윤문 전  →  윤문 후")
    print(f"  S1 (결정타) : {r['before']['s1_total']:>4}건  →  {r['after']['s1_total']:>4}건")
    print(f"  S2 (보조)   : {r['before']['s2_total']:>4}건  →  {r['after']['s2_total']:>4}건")
    print()
    print("  [문체 지표]   윤문 전  →  윤문 후")
    print(f"  쉼표 밀도   : {r['before']['comma_density']:>5}/100자 →  {r['after']['comma_density']:>5}/100자")
    print(f"  문장 분산   : {r['before']['sentence_variance']:>5.1f}     →  {r['after']['sentence_variance']:>5.1f}")
    if r["after"]["s1_detail"]:
        print()
        print("  [잔존 S1 패턴]")
        for pid, cnt in r["after"]["s1_detail"].items():
            print(f"    {pid}: {cnt}건")
    if r["warnings"]:
        print()
        print("  [경고]")
        for w in r["warnings"]:
            print(f"    ! {w}")
    if not r["preservation"]["ok"]:
        print()
        print("  [변경된 보호 토큰]")
        for kind, values in r["preservation"]["changed"].items():
            print(f"    {kind}: {values['before']} → {values['after']}")
    print("=" * 50)


def main():
    parser = argparse.ArgumentParser(description="Humanize Korean 정량 점수 계산기")
    group_orig = parser.add_mutually_exclusive_group(required=True)
    group_orig.add_argument("--original", type=str, help="원문 텍스트 직접 입력")
    group_orig.add_argument("--original-file", type=str, help="원문 파일 경로")

    group_rev = parser.add_mutually_exclusive_group(required=True)
    group_rev.add_argument("--revised", type=str, help="윤문본 텍스트 직접 입력")
    group_rev.add_argument("--revised-file", type=str, help="윤문본 파일 경로")

    parser.add_argument("--json", action="store_true", help="JSON 형식으로 출력")

    args = parser.parse_args()

    if args.original_file:
        with open(args.original_file, encoding="utf-8") as f:
            original = f.read()
    else:
        original = args.original

    if args.revised_file:
        with open(args.revised_file, encoding="utf-8") as f:
            revised = f.read()
    else:
        revised = args.revised

    run(original, revised, as_json=args.json)


if __name__ == "__main__":
    main()
