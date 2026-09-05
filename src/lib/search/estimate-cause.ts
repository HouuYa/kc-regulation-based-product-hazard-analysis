/**
 * 추정한 원인을 검색 입력에 붙인다 (04-1 §7)
 *
 * 원인이 미상인 사건에서만 작동한다. 원인이 확정된 사건은 추정할 이유가 없고,
 * 추정을 섞으면 확정 근거가 흐려진다.
 *
 * 지키는 선
 *   추정한 원인은 case_tag(확정 태그)에 쓰지 않는다. 검색 입력에만 산다.
 *   통계적 추측이 조사 결과로 굳으면 안 되기 때문이다. 그래서 이 함수는 DB 를
 *   고치지 않고 입력 객체만 만들어 돌려준다.
 */

import { estimateCauses, type CauseCandidate } from '../codebook/cause-bridge';
import { isCauseUnresolved, type Candidate, type MatchInput } from './match';

export interface EstimateOutcome {
  /** 추정 원인을 얹은 검색 입력. 추정하지 않았으면 원본 그대로다 */
  input: MatchInput;
  /** 무엇을 근거로 얹었는지. 화면과 match_run 에 남길 내용이다 */
  candidates: CauseCandidate[];
  /** 원인이 이미 확정돼 있어 추정하지 않았다 */
  skipped: boolean;
}

/**
 * @param picked 담당자가 고른 원인 코드. 주면 그것만 쓰고, 안 주면 상위 후보를 쓴다.
 *   화면에서는 담당자가 고르게 하고(§7), 채점에서는 후보를 그대로 넣어 성능을 잰다.
 */
export async function withEstimatedCauses(
  input: MatchInput,
  opts: { picked?: string[]; limit?: number } = {},
): Promise<EstimateOutcome> {
  if (!isCauseUnresolved(input.hfCodes)) {
    return { input, candidates: [], skipped: true };
  }

  const candidates = await estimateCauses(input.dtCodes, { limit: opts.limit ?? 5 });
  const codes = opts.picked?.length
    ? candidates.filter((c) => opts.picked!.includes(c.hfCode))
    : candidates;

  if (codes.length === 0) return { input, candidates: [], skipped: false };

  return {
    input: {
      ...input,
      // HF.UNKNOWN 은 빼고 추정 코드를 넣는다. "원인을 모른다"와 "원인은 이것으로 본다"가
      // 같은 목록에 있으면 코드 갈래가 둘 다 근거로 세기 때문이다
      hfCodes: codes.map((c) => c.hfCode),
      /*
        피해유형을 함께 넣지 않는다 — 실측으로 확인한 것이다 (2026-09-05).

        코드 갈래는 일치한 코드 **개수**로 순위를 매긴다(040 의 code_ranked:
        order by hit_full desc). 사건 5553 은 화재·화상 두 코드를 갖고 있어서
        둘 다 붙은 조항이 hit=2 로 앞자리를 채우고, 추정 원인 하나만 붙은
        절 15.1(내습성)은 hit=1 이라 잘려 나갔다. 후보를 60 으로 늘려도 0건이었고,
        피해유형을 빼자 그 자리에서 4건이 잡혔다.

        섞으면 안 되는 이유는 계산만이 아니다. 결과로 찾는 것("화재를 다루는 조항")과
        원인으로 찾는 것("누전 가능성을 확인할 시험")은 서로 다른 질문이다.
        담당자가 하는 것은 뒤쪽이고, 이 다리가 놓이는 자리도 뒤쪽이다.
        앞쪽 답은 다리를 끈 기존 검색이 이미 내놓는다.
      */
      dtCodes: [],
    },
    candidates: codes,
    skipped: false,
  };
}

/**
 * 결과로 찾은 후보와 원인으로 찾은 후보를 한 목록에 섞는다.
 *
 * 왜 대체가 아니라 병합인가 (2026-09-05 실측)
 *   추정 원인으로 피해유형을 갈아 끼웠더니 정답셋 47건 평균 재현율이
 *   16.2% → 13.1% 로 **떨어졌다**. 사건 5553 처럼 원인으로만 찾히는 건을 얻는
 *   대신, 결과로 이미 맞히던 건을 잃었기 때문이다.
 *
 *   둘은 서로 다른 질문이라 어느 한쪽이 다른 쪽을 대신할 수 없다.
 *   화재를 다루는 조항도 필요하고, 누전 가능성을 확인할 시험도 필요하다.
 *
 * 자리를 늘리지 않는다
 *   후보 수를 늘리면 재현율은 저절로 오른다. 그건 개선이 아니라 목록을 길게 만든
 *   것뿐이고, 담당자가 읽는 양만 늘어난다. 그래서 같은 칸 수를 둘이 번갈아 나눠 쓴다.
 */
export function mergeByRank(fromResult: Candidate[], fromCause: Candidate[], limit: number): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<number>();
  for (let i = 0; out.length < limit && (i < fromResult.length || i < fromCause.length); i++) {
    for (const c of [fromResult[i], fromCause[i]]) {
      if (!c || seen.has(c.clauseId) || out.length >= limit) continue;
      seen.add(c.clauseId);
      out.push(c);
    }
  }
  return out;
}
