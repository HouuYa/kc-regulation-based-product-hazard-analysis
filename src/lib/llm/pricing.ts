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
 * 캐시에는 값이 두 개 붙는다 — 적중은 할인, 기록은 웃돈 (2026-09-08 확인)
 *   같은 프롬프트 앞부분을 다시 보내면 그 부분은 "cached input" 으로 싸게 청구된다.
 *
 *     gpt-5.6-terra   입력 $2.00 / 캐시 적중 $0.20 / 캐시 기록 $2.50
 *     gpt-5.6-luna    입력 $0.20 / 캐시 적중 $0.02 / 캐시 기록 $0.25
 *
 *   적중은 1/10 로 싸지만 **기록은 1.25배로 비싸다.** 적중이 뒤따르면 남는 장사이고
 *   (기록 1.25 + 적중 0.1n < 1.0(n+1) 은 n ≥ 1 에서 성립), 기록만 하고 못 읽으면
 *   그냥 25% 더 낸 것이다. 실측에서 지금이 그 상태다(056).
 *
 *   다만 **기록 토큰이 실제로 그 웃돈으로 청구되는지는 우리가 확인하지 못했다.**
 *   단가표에 칸은 있는데 조건이 적혀 있지 않고, 청구서를 우리가 보지 않는다.
 *   그래서 문맥 길이와 같은 방식으로 범위에 담는다 — 낮은 쪽은 기록분을 일반 입력
 *   단가로, 높은 쪽은 기록 단가로 계산한다. 확인되면 범위를 좁히면 된다.
 *
 * 어떻게 넣나
 *   .env.local 에 100 만 토큰당 미국 달러로 적는다. 없는 칸은 생략한다.
 *
 *     LLM_PRICES={"gpt-5.6-terra":{"input":2,"cachedInput":0.2,"output":12,
 *                                  "inputLong":4,"cachedInputLong":0.4,"outputLong":18}}
 */

export interface ModelPrice {
  /** 100만 입력 토큰당 USD */
  input: number;
  /** 100만 출력 토큰당 USD. 임베딩처럼 출력이 없으면 생략 */
  output?: number;
  /** 캐시 적중 입력의 단가. 없으면 input 과 같다고 본다(비싸게 잡는 쪽) */
  cachedInput?: number;
  /** 캐시 기록 입력의 단가. 일반 입력보다 비싸다. 없으면 input 과 같다고 본다 */
  cacheWrite?: number;
  /** 긴 문맥일 때의 캐시 기록 단가 */
  cacheWriteLong?: number;
  /** 긴 문맥일 때의 입력 단가. 없으면 input 과 같다고 본다 */
  inputLong?: number;
  /** 긴 문맥일 때의 캐시 적중 입력 단가 */
  cachedInputLong?: number;
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
  /** 입력 토큰 중 캐시 적중분. inputTokens 에 포함된 값이다(054). 모르면 0 */
  cachedTokens?: number;
  /** 입력 토큰 중 캐시 기록분. 역시 inputTokens 에 포함된다(056). 모르면 0 */
  cacheWriteTokens?: number;
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

  // 적중분·기록분은 모두 입력 토큰 안에 들어 있다. 빼서 각자의 단가로 매긴다.
  // 기록이 어긋나 합이 입력을 넘겨도 음수가 나오지 않게 막는다
  const cached = Math.min(Math.max(tokens.cachedTokens ?? 0, 0), tokens.inputTokens);
  const written = Math.min(Math.max(tokens.cacheWriteTokens ?? 0, 0), tokens.inputTokens - cached);
  const fresh = tokens.inputTokens - cached - written;

  const calc = (
    inRate: number, cachedRate: number, writeRate: number, outRate: number | undefined,
  ) =>
    (fresh / 1_000_000) * inRate +
    (cached / 1_000_000) * cachedRate +
    (written / 1_000_000) * writeRate +
    (outRate ? (tokens.outputTokens / 1_000_000) * outRate : 0);

  // 낮은 쪽: 짧은 문맥 단가 · 기록분도 일반 입력으로 친다
  const low = calc(p.input, p.cachedInput ?? p.input, p.input, p.output);
  // 높은 쪽: 긴 문맥 단가 · 기록분에 웃돈을 매긴다
  const high = calc(
    p.inputLong ?? p.input,
    p.cachedInputLong ?? p.cachedInput ?? p.inputLong ?? p.input,
    p.cacheWriteLong ?? p.cacheWrite ?? p.inputLong ?? p.input,
    p.outputLong ?? p.output,
  );
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
