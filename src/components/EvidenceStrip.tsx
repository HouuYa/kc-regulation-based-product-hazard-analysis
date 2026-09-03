/**
 * 근거 스트립 — 이 화면의 시그니처
 *
 * 후보 하나가 "왜 여기 있는가"를 한눈에 보여 준다.
 * 설계문서가 요구하는 것이 정확히 이것이다.
 *
 *   §5.1  "결과에는 어느 갈래에서 나왔는지(매칭 경로)를 반드시 표기 →
 *          담당자가 신뢰 수준을 스스로 판단"
 *   §5.4  코드 근거가 없는 후보는 "코드 근거 없음"이라고 화면에 밝힌다
 *   v0.7 §7.7  증거수준 A/B/C/X 로 구분해 표시한다
 *
 * 세 칸은 장식이 아니라 실제 순위 데이터다. 코드·어휘·의미 갈래에서 각각 몇 등으로
 * 걸렸는지를 채움으로 인코딩한다. 세 칸이 모두 찬 후보와 의미 검색에만 걸린 후보를
 * 담당자가 구분하지 못하면, 이 시스템은 근거를 제시한다고 말할 수 없다.
 */

export type MatchPath = 'CODE' | 'CODE-PARTIAL' | 'HYBRID' | 'FALLBACK';
export type EvidenceLevel = 'A' | 'B' | 'C' | 'X';

const BRANCHES = [
  { key: 'code', label: '코드' },
  { key: 'kw', label: '어휘' },
  { key: 'vec', label: '의미' },
] as const;

/** 등수를 채움 정도로 바꾼다. 1등이 가장 진하고 뒤로 갈수록 옅어진다 */
function fillOf(rank: number | null | undefined): number {
  if (rank == null) return 0;
  return Math.max(0.25, 1 - (rank - 1) / 12);
}

const PATH_LABEL: Record<MatchPath, string> = {
  'CODE': '코드 일치',
  'CODE-PARTIAL': '상위계위 일치',
  'HYBRID': '코드 근거 없음',
  'FALLBACK': '코드 없이 찾은 결과',
};

const LEVEL_NOTE: Record<EvidenceLevel, string> = {
  A: '구조화 근거 강함 — 검수된 태그가 일치합니다',
  B: '담당자 확인 필요 — 자동 태그이거나 어휘·의미 일치입니다',
  C: '탐색 후보 — 위해요인 코드 없이 뜻이 비슷한 문장으로만 나왔습니다',
  X: '분석 보류 — 품목·기준이 확정되지 않았습니다',
};

export function EvidenceStrip({
  rankCode,
  rankKeyword,
  rankVector,
  matchPath,
  evidenceLevel,
}: {
  rankCode: number | null;
  rankKeyword: number | null;
  rankVector: number | null;
  matchPath: MatchPath;
  evidenceLevel: EvidenceLevel;
}) {
  const ranks = { code: rankCode, kw: rankKeyword, vec: rankVector };

  // 증거수준이 낮을수록 조용하게. 눈에 띈다고 더 위험한 것이 아니기 때문이다.
  const levelStyle =
    evidenceLevel === 'A' ? 'border-measure text-measure bg-measure-soft'
    : evidenceLevel === 'B' ? 'border-caution text-caution bg-caution-soft'
    : 'border-rule text-ink-3 bg-transparent';

  return (
    <div className="flex items-center gap-3">
      <span
        className={`addr flex h-5 w-5 shrink-0 items-center justify-center border text-[11px] font-semibold ${levelStyle}`}
        title={LEVEL_NOTE[evidenceLevel]}
      >
        {evidenceLevel}
      </span>

      <span className="flex items-end gap-[3px]" aria-hidden>
        {BRANCHES.map((b) => {
          const rank = ranks[b.key];
          const fill = fillOf(rank);
          return (
            <span
              key={b.key}
              className="block h-[14px] w-[5px] bg-rule-soft"
              title={rank ? `${b.label} 갈래 ${rank}위` : `${b.label} 갈래 미검출`}
            >
              <span
                className="block w-full bg-measure"
                style={{ height: `${fill * 100}%`, marginTop: `${(1 - fill) * 100}%` }}
              />
            </span>
          );
        })}
      </span>

      <span className="sr-only">
        {BRANCHES.map((b) =>
          ranks[b.key] ? `${b.label} 갈래 ${ranks[b.key]}위. ` : `${b.label} 갈래 미검출. `,
        )}
      </span>

      <span
        className={`text-[11px] ${matchPath === 'HYBRID' || matchPath === 'FALLBACK' ? 'text-caution' : 'text-ink-2'}`}
      >
        {PATH_LABEL[matchPath]}
      </span>
    </div>
  );
}
