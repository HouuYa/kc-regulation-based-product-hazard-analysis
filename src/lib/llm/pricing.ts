/**
 * 토큰을 돈으로 바꾸는 단가표
 *
 * 왜 코드에 값을 박지 않나
 *   모델 단가는 바뀐다. 코드에 박아 두면 어느 시점의 값인지 알 수 없게 되고,
 *   낡은 단가로 계산한 금액이 맞는 값처럼 화면에 뜬다. 그래서 단가는 환경변수로
 *   받고, **등록되지 않은 모델은 금액을 계산하지 않는다.**
 *
 *   모르는 것을 0 으로 적으면 비용이 실제보다 적어 보인다. 그것이 이 화면에서
 *   가장 나쁜 고장이다 — 담당자가 "얼마 안 드네"라고 판단하게 된다.
 *
 * 왜 금액이 하나가 아니라 범위인가 (2026-09-07 확인)
 *   OpenAI 단가표가 같은 모델에 **short context 와 long context 두 단가**를
 *   매기는데, 어느 길이부터 long 인지는 그 페이지에 적혀 있지 않다.
 *
 *     gpt-5.6-terra   short 입력 $2.00 · 출력 $12.00   /   long 입력 $4.00 · 출력 $18.00
 *
 *   경계를 모르는 채 낮은 쪽만 쓰면 금액이 실제보다 적게 나오고, 높은 쪽만 쓰면
 *   부풀려진다. 그래서 **둘 다 계산해 범위로 보여 준다.** 정확한 한 숫자를
 *   지어내는 것보다 "이 사이"라고 말하는 편이 정직하다.
 *
 * 어떻게 넣나
 *   .env.local 에 100 만 토큰당 미국 달러로 적는다. long 단가는 없으면 생략한다.
 *
 *     LLM_PRICES={"gpt-5.6-terra":{"input":2,"output":12,"inputLong":4,"outputLong":18}}
 */

export interface ModelPrice {
  /** 100만 입력 토큰당 USD */
  input: number;
  /** 100만 출력 토큰당 USD. 임베딩처럼 출력이 없으면 생략 */
  output?: number;
  /** 긴 문맥일 때의 입력 단가. 없으면 input 과 같다고 본다 */
  inputLong?: number;
  /** 긴 문맥일 때의 출력 단가 */
  outputLong?: number;
}

let cache: Record<string, ModelPrice> | null = null;

export function priceTable(): Record<string, ModelPrice> {
  if (cache) return cache;
  const raw = process.env.LLM_PRICES;
  if (!raw) return (cache = {});
  try {
    return (cache = JSON.parse(raw) as Record<string, ModelPrice>);
  } catch (e) {
    console.warn('LLM_PRICES 를 읽지 못했습니다. 금액을 계산하지 않습니다:', e instanceof Error ? e.message : e);
    return (cache = {});
  }
}

export interface TokenCount {
  inputTokens: number;
  outputTokens: number;
}

/** 가장 싸게 잡았을 때와 비싸게 잡았을 때. 두 단가가 같으면 min === max */
export interface CostRange {
  min: number;
  max: number;
}

export function addCost(a: CostRange, b: CostRange): CostRange {
  return { min: a.min + b.min, max: a.max + b.max };
}

/**
 * 토큰 수를 달러 범위로 바꾼다. 단가가 등록되지 않은 모델이면 null.
 *
 * 추론 토큰은 따로 더하지 않는다 — 출력 토큰에 이미 포함돼 청구된다.
 */
export function estimateCost(model: string, tokens: TokenCount): CostRange | null {
  const p = priceTable()[model];
  if (!p) return null;

  const calc = (inRate: number, outRate: number | undefined) =>
    (tokens.inputTokens / 1_000_000) * inRate +
    (outRate ? (tokens.outputTokens / 1_000_000) * outRate : 0);

  const low = calc(p.input, p.output);
  const high = calc(p.inputLong ?? p.input, p.outputLong ?? p.output);
  return { min: Math.min(low, high), max: Math.max(low, high) };
}

const money = (usd: number): string => (usd < 0.01 ? '$0.01 미만' : `$${usd.toFixed(2)}`);

/**
 * 금액을 화면에 쓸 문자열로. 단가를 모르면 그 사실을 그대로 말한다.
 *
 * 범위가 벌어져 있으면 "$1.20~$2.10" 처럼 그대로 보인다. 한 숫자로 뭉뚱그리면
 * 그 값이 확정된 금액처럼 읽히기 때문이다.
 */
export function formatCost(cost: CostRange | null): string {
  if (cost === null) return '단가 미등록';
  if (Math.abs(cost.max - cost.min) < 0.005) return money(cost.max);
  return `${money(cost.min)}~${money(cost.max)}`;
}
